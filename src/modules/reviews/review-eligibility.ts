import { PaymentStatus, ReviewAuthorRole } from '@prisma/client';

/** Como acabou uma reserva, no que interessa para a avaliar. */
export interface ReservationOutcome {
  /** Só uma reserva concluída ou cancelada se avalia. */
  finished: 'completed' | 'cancelled' | null;
  /** O pagamento, se a reserva chegou a ter um. */
  payment: { heldAt: Date | null; status: PaymentStatus } | null;
  /** O provider falhou: levou strike por esta reserva ou perdeu a disputa. */
  providerAtFault: boolean;
}

export type Reviewers = 'both' | 'client' | 'nobody';

/** Estados em que o provider ficou com dinheiro da reserva. */
const PROVIDER_WAS_PAID: PaymentStatus[] = [
  PaymentStatus.RELEASED,
  PaymentStatus.PARTIALLY_REFUNDED,
];

/**
 * Quem pode avaliar uma reserva.
 *
 * Avalia-se o que aconteceu de facto. Numa reserva cancelada com o dinheiro
 * todo devolvido não chegou a haver negócio: sem esta regra, reservar, pagar
 * e cancelar a tempo dava direito a deixar uma nota. A excepção é o
 * cancelamento por falha do provider, que o cliente pode avaliar.
 */
export function whoMayReview(outcome: ReservationOutcome): Reviewers {
  if (!outcome.finished || !outcome.payment?.heldAt) return 'nobody';
  if (outcome.finished === 'completed') return 'both';
  if (PROVIDER_WAS_PAID.includes(outcome.payment.status)) return 'both';

  return outcome.providerAtFault ? 'client' : 'nobody';
}

export function mayReviewAs(
  reviewers: Reviewers,
  role: ReviewAuthorRole,
): boolean {
  return (
    reviewers === 'both' ||
    (reviewers === 'client' && role === ReviewAuthorRole.CLIENT)
  );
}
