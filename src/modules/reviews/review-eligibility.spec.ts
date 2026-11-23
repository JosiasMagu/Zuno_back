import { PaymentStatus, ReviewAuthorRole } from '@prisma/client';

import {
  mayReviewAs,
  ReservationOutcome,
  whoMayReview,
} from './review-eligibility';

const outcome = (
  overrides: Partial<ReservationOutcome> = {},
): ReservationOutcome => ({
  finished: 'completed',
  payment: { heldAt: new Date(), status: PaymentStatus.RELEASED },
  providerAtFault: false,
  ...overrides,
});

const cancelledWith = (status: PaymentStatus, providerAtFault = false) =>
  outcome({
    finished: 'cancelled',
    payment: { heldAt: new Date(), status },
    providerAtFault,
  });

describe('whoMayReview', () => {
  it('deixa os dois avaliar uma reserva concluída e paga', () => {
    expect(whoMayReview(outcome())).toBe('both');
  });

  it('não deixa avaliar uma reserva que ainda está em curso', () => {
    expect(whoMayReview(outcome({ finished: null }))).toBe('nobody');
  });

  it('não deixa avaliar uma reserva cujo dinheiro nunca entrou no escrow', () => {
    expect(whoMayReview(outcome({ payment: null }))).toBe('nobody');
    expect(
      whoMayReview(
        outcome({ payment: { heldAt: null, status: PaymentStatus.FAILED } }),
      ),
    ).toBe('nobody');
  });

  it.each([PaymentStatus.RELEASED, PaymentStatus.PARTIALLY_REFUNDED])(
    'deixa os dois avaliar um cancelamento em que o provider ficou com dinheiro (%s)',
    (status) => {
      expect(whoMayReview(cancelledWith(status))).toBe('both');
    },
  );

  it('não deixa ninguém avaliar um cancelamento com o dinheiro todo devolvido', () => {
    expect(whoMayReview(cancelledWith(PaymentStatus.REFUNDED))).toBe('nobody');
  });

  it('deixa só o cliente avaliar quando o dinheiro voltou por falha do provider', () => {
    expect(whoMayReview(cancelledWith(PaymentStatus.REFUNDED, true))).toBe(
      'client',
    );
  });
});

describe('mayReviewAs', () => {
  it.each([
    ['both', ReviewAuthorRole.CLIENT, true],
    ['both', ReviewAuthorRole.PROVIDER, true],
    ['client', ReviewAuthorRole.CLIENT, true],
    ['client', ReviewAuthorRole.PROVIDER, false],
    ['nobody', ReviewAuthorRole.CLIENT, false],
  ] as const)('%s, como %s: %s', (reviewers, role, expected) => {
    expect(mayReviewAs(reviewers, role)).toBe(expected);
  });
});
