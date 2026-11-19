import { Injectable, Logger } from '@nestjs/common';
import { DisputeStatus, DisputeType } from '@prisma/client';

import { DISPUTE_RESPONSE_WINDOW_DAYS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { describeError } from '../../../shared/scheduling/process-due';

interface Party {
  id: string;
  name: string;
  pushToken: string | null;
}

/** O que os avisos precisam de saber de uma disputa. */
interface NotifiableDispute {
  type: DisputeType;
  status: DisputeStatus;
  /** Quem abriu a disputa. */
  opener: Party;
  /** A outra parte, que responde. */
  respondent: Party;
  /** Título do equipamento ou do serviço. */
  subject: string;
}

interface Notice {
  to: Party;
  title: string;
  body: string;
}

const PARTY_SELECT = { id: true, name: true, pushToken: true } as const;

const OUTCOMES: Partial<Record<DisputeStatus, string>> = {
  [DisputeStatus.RESOLVED_CLIENT]: 'a favor do cliente',
  [DisputeStatus.RESOLVED_OWNER]: 'a favor do prestador',
  [DisputeStatus.RESOLVED_PARTIAL]: 'com uma divisão do valor',
};

/**
 * Avisos push das disputas. Cada um sai quando a outra parte passa a ter
 * alguma coisa para fazer ou para saber: responder, esperar pela análise,
 * conhecer a decisão. Um aviso que falha fica só no log.
 */
@Injectable()
export class DisputeNotifier {
  private readonly logger = new Logger(DisputeNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Alguém abriu uma disputa: a outra parte fica a saber e tem prazo para responder. */
  opened(disputeId: string): Promise<void> {
    return this.notify(disputeId, ({ type, opener, respondent, subject }) => [
      {
        to: respondent,
        title:
          type === DisputeType.DEPOSIT
            ? 'Reclamação do depósito'
            : 'Disputa aberta',
        body: `${opener.name} abriu uma disputa sobre "${subject}". Tens ${DISPUTE_RESPONSE_WINDOW_DAYS} dias para responder com a tua versão e as tuas provas.`,
      },
    ]);
  }

  responded(disputeId: string): Promise<void> {
    return this.notify(disputeId, ({ opener, respondent, subject }) => [
      {
        to: opener,
        title: 'Resposta à disputa',
        body: `${respondent.name} respondeu à disputa sobre "${subject}". Um administrador vai analisar.`,
      },
    ]);
  }

  /** O prazo de resposta passou e a disputa segue para análise sem ela. */
  responseWindowClosed(disputeId: string): Promise<void> {
    return this.notify(disputeId, ({ opener, respondent, subject }) => [
      {
        to: opener,
        title: 'Disputa em análise',
        body: `O prazo de resposta da disputa sobre "${subject}" terminou. Um administrador vai decidir com o que tem.`,
      },
      {
        to: respondent,
        title: 'Prazo de resposta terminado',
        body: `Não respondeste à disputa sobre "${subject}" dentro do prazo. Um administrador vai decidir sem a tua versão.`,
      },
    ]);
  }

  resolved(disputeId: string): Promise<void> {
    return this.notify(disputeId, ({ status, opener, respondent, subject }) =>
      [opener, respondent].map((to) => ({
        to,
        title: 'Disputa resolvida',
        body: `A disputa sobre "${subject}" foi resolvida ${OUTCOMES[status] ?? ''}. Vê os detalhes na reserva.`,
      })),
    );
  }

  /**
   * A disputa foi retirada. A outra parte fica a saber. Quem a abriu também,
   * quando foi um admin a arquivá-la.
   */
  withdrawn(disputeId: string, by: { opener: boolean }): Promise<void> {
    return this.notify(disputeId, ({ opener, respondent, subject }) => [
      {
        to: respondent,
        title: 'Disputa retirada',
        body: `A disputa sobre "${subject}" foi retirada. A reserva segue o caminho normal.`,
      },
      ...(by.opener
        ? []
        : [
            {
              to: opener,
              title: 'Disputa arquivada',
              body: `Um administrador arquivou a tua disputa sobre "${subject}". A reserva segue o caminho normal.`,
            },
          ]),
    ]);
  }

  private async notify(
    disputeId: string,
    compose: (dispute: NotifiableDispute) => Notice[],
  ): Promise<void> {
    try {
      const dispute = await this.load(disputeId);
      if (!dispute) return;

      await Promise.all(
        compose(dispute).flatMap(({ to, title, body }) =>
          to.pushToken
            ? [
                this.push.send({
                  to: to.pushToken,
                  title,
                  body,
                  data: { type: 'dispute', disputeId },
                }),
              ]
            : [],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Aviso da disputa ${disputeId} falhou: ${describeError(error)}`,
      );
    }
  }

  private async load(disputeId: string): Promise<NotifiableDispute | null> {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        type: true,
        status: true,
        openedBy: true,
        booking: {
          select: {
            client: { select: PARTY_SELECT },
            owner: { select: PARTY_SELECT },
            equipment: { select: { title: true } },
          },
        },
        serviceBooking: {
          select: {
            client: { select: PARTY_SELECT },
            provider: { select: PARTY_SELECT },
            service: { select: { title: true } },
          },
        },
      },
    });

    const client = dispute?.booking?.client ?? dispute?.serviceBooking?.client;
    const provider =
      dispute?.booking?.owner ?? dispute?.serviceBooking?.provider;

    if (!dispute || !client || !provider) {
      return null;
    }

    const openedByClient = dispute.openedBy === client.id;

    return {
      type: dispute.type,
      status: dispute.status,
      opener: openedByClient ? client : provider,
      respondent: openedByClient ? provider : client,
      subject:
        dispute.booking?.equipment.title ??
        dispute.serviceBooking?.service.title ??
        '',
    };
  }
}
