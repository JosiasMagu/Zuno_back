import { Injectable, Logger } from '@nestjs/common';
import { PayoutKind } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { describeError } from '../../../shared/scheduling/process-due';

interface Notice {
  pushToken: string | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

const PAYMENT_PARTIES_SELECT = {
  bookingId: true,
  serviceBookingId: true,
  client: { select: { pushToken: true } },
  owner: { select: { pushToken: true } },
  booking: { select: { equipment: { select: { title: true } } } },
  serviceBooking: { select: { service: { select: { title: true } } } },
} as const;

/** O que o destinatário lê, conforme o tipo do payout. */
const PAYOUT_SUBJECT: Record<PayoutKind, string> = {
  [PayoutKind.PROVIDER_PAYOUT]: 'o pagamento',
  [PayoutKind.CLIENT_REFUND]: 'o reembolso',
  [PayoutKind.DEPOSIT_RETURN]: 'o depósito',
  [PayoutKind.DEPOSIT_CLAIM]: 'o valor do depósito',
};

const mzn = (value: unknown) =>
  `${Number(value).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MZN`;

/**
 * Avisos push dos pagamentos. Sai um aviso sempre que o dinheiro de alguém
 * se move: entra, é libertado, é enviado, falha, ou vai ser libertado
 * sozinho. Um aviso que falha nunca desfaz o que já foi feito, e o erro fica
 * só no log.
 */
@Injectable()
export class PaymentNotifier {
  private readonly logger = new Logger(PaymentNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /**
   * O pagamento entrou no escrow. O cliente fica a saber que a reserva está
   * garantida, e o provider que já pode entregar o equipamento ou começar o
   * serviço.
   */
  held(paymentId: string): Promise<void> {
    return this.forPayment(paymentId, ({ title, isService, data, payment }) => [
      {
        pushToken: payment.client.pushToken,
        title: 'Pagamento confirmado',
        body: `O teu pagamento de "${title}" foi confirmado e fica guardado até confirmares que correu tudo bem.`,
        data,
      },
      {
        pushToken: payment.owner.pushToken,
        title: 'Pagamento confirmado',
        body: isService
          ? `O pagamento de "${title}" foi confirmado. Já podes começar o serviço.`
          : `O pagamento de "${title}" foi confirmado. Já podes entregar o equipamento.`,
        data,
      },
    ]);
  }

  /**
   * O pagamento foi libertado ao provider. O envio para o M-Pesa dele ainda
   * está por fazer, por isso o aviso não diz que já recebeu.
   */
  released(paymentId: string, options: { automatic: boolean }): Promise<void> {
    return this.forPayment(paymentId, ({ title, data, payment }) => [
      {
        pushToken: payment.owner.pushToken,
        title: 'Pagamento libertado',
        body: `O pagamento de "${title}" foi libertado. O envio para o teu M-Pesa está a ser processado.`,
        data,
      },
      ...(options.automatic
        ? [
            {
              pushToken: payment.client.pushToken,
              title: 'Pagamento libertado',
              body: `O prazo para confirmares ou reportares um problema em "${title}" terminou, e o pagamento foi libertado ao dono.`,
              data,
            },
          ]
        : []),
    ]);
  }

  /** A cobrança no telemóvel não passou. O cliente pode tentar outra vez. */
  collectionFailed(paymentId: string, reason: string): Promise<void> {
    return this.forPayment(paymentId, ({ title, data, payment }) => [
      {
        pushToken: payment.client.pushToken,
        title: 'Pagamento não concluído',
        body: `O pagamento de "${title}" não foi concluído: ${reason} Podes tentar outra vez na reserva.`,
        data,
      },
    ]);
  }

  /**
   * A libertação automática aproxima-se. É este aviso que torna o prazo
   * justo: o cliente sabe até quando pode reportar um problema.
   */
  autoReleaseReminder(paymentId: string, releaseAt: Date): Promise<void> {
    const when = releaseAt.toLocaleString('pt-PT', {
      timeZone: 'Africa/Maputo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    return this.forPayment(paymentId, ({ title, data, payment }) => [
      {
        pushToken: payment.client.pushToken,
        title: 'Confirma ou reporta um problema',
        body: `Se não confirmares a recepção nem reportares um problema em "${title}" até ${when}, o pagamento é libertado ao dono.`,
        data,
      },
    ]);
  }

  /** O dinheiro saiu para o M-Pesa do destinatário. */
  payoutExecuted(payoutId: string): Promise<void> {
    return this.forPayout(payoutId, (payout) => ({
      pushToken: payout.recipient.pushToken,
      title: 'Dinheiro enviado',
      body: `Enviámos ${PAYOUT_SUBJECT[payout.kind]} de ${mzn(payout.amount)} para o teu M-Pesa${payout.mpesaReference ? ` (referência ${payout.mpesaReference})` : ''}.`,
      data: { type: 'payout', payoutId },
    }));
  }

  /** O envio falhou. Normalmente é o número de recebimento. */
  payoutFailed(payoutId: string): Promise<void> {
    return this.forPayout(payoutId, (payout) => ({
      pushToken: payout.recipient.pushToken,
      title: 'Não conseguimos enviar o teu dinheiro',
      body: `O envio de ${PAYOUT_SUBJECT[payout.kind]} de ${mzn(payout.amount)} falhou. Confirma o teu número de recebimento M-Pesa no perfil.`,
      data: { type: 'payout', payoutId },
    }));
  }

  private async forPayment(
    paymentId: string,
    compose: (context: {
      title: string;
      isService: boolean;
      data: Record<string, unknown>;
      payment: {
        client: { pushToken: string | null };
        owner: { pushToken: string | null };
      };
    }) => Notice[],
  ): Promise<void> {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: PAYMENT_PARTIES_SELECT,
      });
      if (!payment) return;

      const isService = Boolean(payment.serviceBookingId);
      const title =
        payment.booking?.equipment.title ??
        payment.serviceBooking?.service.title ??
        '';
      const data = isService
        ? { type: 'serviceBooking', serviceBookingId: payment.serviceBookingId }
        : { type: 'booking', bookingId: payment.bookingId };

      await this.sendAll(compose({ title, isService, data, payment }));
    } catch (error) {
      this.logger.warn(
        `Aviso do pagamento ${paymentId} falhou: ${describeError(error)}`,
      );
    }
  }

  private async forPayout(
    payoutId: string,
    compose: (payout: {
      kind: PayoutKind;
      amount: unknown;
      mpesaReference: string | null;
      recipient: { pushToken: string | null };
    }) => Notice,
  ): Promise<void> {
    try {
      const payout = await this.prisma.payout.findUnique({
        where: { id: payoutId },
        select: {
          kind: true,
          amount: true,
          mpesaReference: true,
          recipient: { select: { pushToken: true } },
        },
      });
      if (!payout) return;

      await this.sendAll([compose(payout)]);
    } catch (error) {
      this.logger.warn(
        `Aviso do payout ${payoutId} falhou: ${describeError(error)}`,
      );
    }
  }

  private async sendAll(notices: Notice[]): Promise<void> {
    await Promise.all(
      notices.flatMap((notice) =>
        notice.pushToken
          ? [
              this.push.send({
                to: notice.pushToken,
                title: notice.title,
                body: notice.body,
                data: notice.data,
              }),
            ]
          : [],
      ),
    );
  }
}
