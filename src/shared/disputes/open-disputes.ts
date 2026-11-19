import { DisputeStatus, Prisma } from '@prisma/client';

/** Estados em que uma disputa ainda está por decidir. */
export const OPEN_DISPUTE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.AWAITING_OWNER,
  DisputeStatus.UNDER_REVIEW,
];

/** Filtro das disputas abertas de uma reserva ou de um pagamento. */
export const OPEN_DISPUTES = {
  status: { in: OPEN_DISPUTE_STATUSES },
} satisfies Prisma.DisputeWhereInput;

/**
 * Para um `include` ou `select` de uma reserva ou de um pagamento: traz a
 * disputa aberta, se houver. Uma reserva pode ter várias disputas ao longo da
 * vida, mas só uma aberta de cada vez.
 */
export const OPEN_DISPUTE_SELECT = {
  where: OPEN_DISPUTES,
  select: { id: true, status: true },
  take: 1,
} satisfies Prisma.DisputeFindManyArgs;

export function isOpenDispute(status: DisputeStatus): boolean {
  return OPEN_DISPUTE_STATUSES.includes(status);
}

/**
 * Filtro de relação: nenhuma disputa impede o sistema de libertar o dinheiro
 * sozinho. Impede-o uma disputa aberta, e também uma retirada depois de
 * `since`: enquanto ela esteve aberta a outra parte não podia abrir a sua,
 * por isso volta a ter o prazo inteiro.
 */
export function noDisputeBlockingSince(
  since: Date,
): Prisma.DisputeListRelationFilter {
  return {
    none: {
      OR: [
        OPEN_DISPUTES,
        { status: DisputeStatus.WITHDRAWN, closedAt: { gt: since } },
      ],
    },
  };
}
