import { Injectable, Logger } from '@nestjs/common';

import type { CancellingParty } from '../../../shared/bookings/cancelling-party';
import { SERVICE_AUTO_RELEASE_DAYS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { describeError } from '../../../shared/scheduling/process-due';

interface Party {
  name: string;
  pushToken: string | null;
}

interface NotifiableBooking {
  client: Party;
  provider: Party;
  service: { title: string };
}

interface Notice {
  to: Party;
  title: string;
  body: string;
}

/**
 * Avisos push das reservas de serviço.
 *
 * Cada aviso sai num momento em que passa a contar um prazo para quem o
 * recebe: pagar, começar, confirmar a conclusão. Um aviso que falha nunca
 * desfaz o que já foi feito, e o erro fica só no log.
 */
@Injectable()
export class ServiceBookingNotifier {
  private readonly logger = new Logger(ServiceBookingNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** O cliente aceitou o orçamento e o provider fica a saber que tem trabalho. */
  quoteAccepted(bookingId: string): Promise<void> {
    return this.notify(bookingId, ({ client, provider, service }) => [
      {
        to: provider,
        title: 'Orçamento aceite',
        body: `${client.name} aceitou o teu orçamento de "${service.title}". Podes começar assim que o pagamento for confirmado.`,
      },
    ]);
  }

  started(bookingId: string): Promise<void> {
    return this.notify(bookingId, ({ client, provider, service }) => [
      {
        to: client,
        title: 'Serviço iniciado',
        body: `${provider.name} começou "${service.title}".`,
      },
    ]);
  }

  /** O provider deu o serviço por concluído e começa a contar o prazo do cliente. */
  completed(bookingId: string): Promise<void> {
    return this.notify(bookingId, ({ client, provider, service }) => [
      {
        to: client,
        title: 'Serviço concluído',
        body: `${provider.name} deu "${service.title}" por concluído. Confirma e liberta o pagamento, ou abre uma disputa se algo correu mal. Sem resposta em ${SERVICE_AUTO_RELEASE_DAYS} dias, o pagamento é libertado.`,
      },
    ]);
  }

  /** Avisa quem não cancelou. Quando é o admin a cancelar, avisa as duas partes. */
  cancelled(bookingId: string, cancelledBy: CancellingParty): Promise<void> {
    return this.notify(bookingId, ({ client, provider, service }) => {
      const toClient: Notice = {
        to: client,
        title: 'Reserva cancelada',
        body:
          cancelledBy === 'PROVIDER'
            ? `${provider.name} cancelou "${service.title}". Se já tinhas pago, o valor vai ser devolvido.`
            : `A reserva de "${service.title}" foi cancelada. Se já tinhas pago, o valor vai ser devolvido.`,
      };
      const toProvider: Notice = {
        to: provider,
        title: 'Reserva cancelada',
        body:
          cancelledBy === 'CLIENT'
            ? `${client.name} cancelou a reserva de "${service.title}".`
            : `A reserva de "${service.title}" foi cancelada.`,
      };

      if (cancelledBy === 'CLIENT') return [toProvider];
      if (cancelledBy === 'PROVIDER') return [toClient];
      return [toClient, toProvider];
    });
  }

  /** A reserva expirou por falta de pagamento confirmado. */
  expired(bookingId: string, paymentWasDeclared: boolean): Promise<void> {
    return this.notify(bookingId, ({ client, provider, service }) => [
      {
        to: client,
        title: 'Reserva expirada',
        body: paymentWasDeclared
          ? `Não foi possível confirmar o pagamento de "${service.title}" e a reserva expirou. Se pagaste, contacta o suporte com a referência M-Pesa.`
          : `A reserva de "${service.title}" expirou porque o pagamento não foi feito a tempo.`,
      },
      {
        to: provider,
        title: 'Reserva expirada',
        body: `A reserva de "${service.title}" de ${client.name} expirou sem pagamento confirmado.`,
      },
    ]);
  }

  private async notify(
    bookingId: string,
    compose: (booking: NotifiableBooking) => Notice[],
  ): Promise<void> {
    try {
      const booking = await this.prisma.serviceBooking.findUnique({
        where: { id: bookingId },
        select: {
          client: { select: { name: true, pushToken: true } },
          provider: { select: { name: true, pushToken: true } },
          service: { select: { title: true } },
        },
      });
      if (!booking) return;

      await Promise.all(
        compose(booking).flatMap(({ to, title, body }) =>
          to.pushToken
            ? [
                this.push.send({
                  to: to.pushToken,
                  title,
                  body,
                  data: { type: 'serviceBooking', serviceBookingId: bookingId },
                }),
              ]
            : [],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Aviso da reserva de serviço ${bookingId} falhou: ${describeError(error)}`,
      );
    }
  }
}
