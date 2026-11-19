import {
  BookingStatus,
  DepositStatus,
  PaymentStatus,
  ServiceBookingStatus,
} from '@prisma/client';

import {
  PaymentSnapshot,
  reconcilePayment,
  ReconciliationCheck,
} from './reconciliation';

// Aluguer de 4500 MZN com 450 de taxa e 5000 de depósito: o cliente paga 9950.
const TOTAL = 9950;
const DEPOSIT = 5000;
const PROVIDER_SHARE = 4050;
const PLATFORM_SHARE = 900;

/** Pagamento retido e por mexer: tudo o que entrou continua no escrow. */
const held = (overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot => ({
  id: 'payment-uuid-001',
  receiptNumber: 'ZUNO-1-0001',
  status: PaymentStatus.HELD,
  depositStatus: DepositStatus.HELD,
  totalCharged: TOTAL,
  depositAmount: DEPOSIT,
  everHeld: true,
  bookingStatus: BookingStatus.CONFIRMED,
  serviceBookingStatus: null,
  ledger: {
    inflow: TOTAL,
    outflowToClient: 0,
    outflowToProvider: 0,
    outflowToPlatform: 0,
  },
  payouts: { toClient: 0, toProvider: 0 },
  ...overrides,
});

/** Entrega confirmada: o aluguer saiu e o depósito continua retido. */
const released = (overrides: Partial<PaymentSnapshot> = {}) =>
  held({
    status: PaymentStatus.RELEASED,
    bookingStatus: BookingStatus.ACTIVE,
    ledger: {
      inflow: TOTAL,
      outflowToClient: 0,
      outflowToProvider: PROVIDER_SHARE,
      outflowToPlatform: PLATFORM_SHARE,
    },
    payouts: { toClient: 0, toProvider: PROVIDER_SHARE },
    ...overrides,
  });

// Disputa resolvida com 40% do aluguer de volta ao cliente: 1800 para ele,
// 2250 para o provider e a taxa inteira para a plataforma.
const SPLIT_REFUND = 1800;
const SPLIT_PROVIDER_SHARE = 2250;

/** Aluguer repartido por uma disputa: o depósito fica retido até à devolução. */
const split = (overrides: Partial<PaymentSnapshot> = {}) =>
  held({
    status: PaymentStatus.PARTIALLY_REFUNDED,
    bookingStatus: BookingStatus.ACTIVE,
    ledger: {
      inflow: TOTAL,
      outflowToClient: SPLIT_REFUND,
      outflowToProvider: SPLIT_PROVIDER_SHARE,
      outflowToPlatform: PLATFORM_SHARE,
    },
    payouts: { toClient: SPLIT_REFUND, toProvider: SPLIT_PROVIDER_SHARE },
    ...overrides,
  });

const checksOf = (payment: PaymentSnapshot) =>
  reconcilePayment(payment).map(({ check }) => check);

describe('reconcilePayment', () => {
  describe('payments where everything adds up', () => {
    it.each<[string, PaymentSnapshot]>([
      [
        'a payment still waiting for the money',
        held({
          status: PaymentStatus.PENDING,
          depositStatus: DepositStatus.NONE,
          everHeld: false,
          ledger: {
            inflow: 0,
            outflowToClient: 0,
            outflowToProvider: 0,
            outflowToPlatform: 0,
          },
        }),
      ],
      ['a payment held in escrow', held()],
      ['a delivered rental with the deposit still held', released()],
      [
        'a finished rental with the deposit returned',
        released({
          depositStatus: DepositStatus.RETURNED,
          bookingStatus: BookingStatus.COMPLETED,
          ledger: {
            inflow: TOTAL,
            outflowToClient: DEPOSIT,
            outflowToProvider: PROVIDER_SHARE,
            outflowToPlatform: PLATFORM_SHARE,
          },
          payouts: { toClient: DEPOSIT, toProvider: PROVIDER_SHARE },
        }),
      ],
      [
        'a deposit under dispute after the delivery',
        released({ bookingStatus: BookingStatus.DISPUTED }),
      ],
      ['a rental split by a dispute, with the deposit still held', split()],
      [
        'a split rental whose deposit is now under dispute',
        split({ bookingStatus: BookingStatus.DISPUTED }),
      ],
      [
        'a split rental finished with the deposit returned',
        split({
          depositStatus: DepositStatus.RETURNED,
          bookingStatus: BookingStatus.COMPLETED,
          ledger: {
            inflow: TOTAL,
            outflowToClient: SPLIT_REFUND + DEPOSIT,
            outflowToProvider: SPLIT_PROVIDER_SHARE,
            outflowToPlatform: PLATFORM_SHARE,
          },
          payouts: {
            toClient: SPLIT_REFUND + DEPOSIT,
            toProvider: SPLIT_PROVIDER_SHARE,
          },
        }),
      ],
      [
        'a cancelled booking refunded in full',
        held({
          status: PaymentStatus.REFUNDED,
          depositStatus: DepositStatus.RETURNED,
          bookingStatus: BookingStatus.CANCELLED,
          ledger: {
            inflow: TOTAL,
            outflowToClient: TOTAL,
            outflowToProvider: 0,
            outflowToPlatform: 0,
          },
          payouts: { toClient: TOTAL, toProvider: 0 },
        }),
      ],
      [
        'an expired booking that was never paid',
        held({
          status: PaymentStatus.FAILED,
          depositStatus: DepositStatus.NONE,
          everHeld: false,
          bookingStatus: BookingStatus.EXPIRED,
          ledger: {
            inflow: 0,
            outflowToClient: 0,
            outflowToProvider: 0,
            outflowToPlatform: 0,
          },
        }),
      ],
      [
        'a paid service waiting for the provider to start',
        held({
          depositStatus: DepositStatus.NONE,
          totalCharged: 5500,
          depositAmount: 0,
          bookingStatus: null,
          serviceBookingStatus: ServiceBookingStatus.PENDING,
          ledger: {
            inflow: 5500,
            outflowToClient: 0,
            outflowToProvider: 0,
            outflowToPlatform: 0,
          },
        }),
      ],
      [
        'a completed service already paid to the provider',
        held({
          status: PaymentStatus.RELEASED,
          depositStatus: DepositStatus.NONE,
          totalCharged: 5500,
          depositAmount: 0,
          bookingStatus: null,
          serviceBookingStatus: ServiceBookingStatus.COMPLETED,
          ledger: {
            inflow: 5500,
            outflowToClient: 0,
            outflowToProvider: 4500,
            outflowToPlatform: 1000,
          },
          payouts: { toClient: 0, toProvider: 4500 },
        }),
      ],
    ])('finds nothing wrong with %s', (_label, payment) => {
      expect(reconcilePayment(payment)).toEqual([]);
    });
  });

  describe('money that came in', () => {
    it('flags a held payment with no inflow in the ledger', () => {
      const payment = held({
        ledger: {
          inflow: 0,
          outflowToClient: 0,
          outflowToProvider: 0,
          outflowToPlatform: 0,
        },
      });

      expect(checksOf(payment)).toContain(ReconciliationCheck.INFLOW_MISMATCH);
    });

    it('flags an inflow smaller than what was charged', () => {
      const payment = held({
        ledger: {
          inflow: TOTAL - 0.01,
          outflowToClient: 0,
          outflowToProvider: 0,
          outflowToPlatform: 0,
        },
      });

      expect(checksOf(payment)).toContain(ReconciliationCheck.INFLOW_MISMATCH);
    });

    it('flags an inflow on a payment whose money never arrived', () => {
      const payment = held({
        status: PaymentStatus.FAILED,
        depositStatus: DepositStatus.NONE,
        everHeld: false,
        bookingStatus: BookingStatus.EXPIRED,
      });

      expect(checksOf(payment)).toContain(ReconciliationCheck.INFLOW_MISMATCH);
    });
  });

  describe('money that went out', () => {
    it('flags more money out than came in', () => {
      const payment = held({
        status: PaymentStatus.REFUNDED,
        depositStatus: DepositStatus.RETURNED,
        bookingStatus: BookingStatus.CANCELLED,
        ledger: {
          inflow: TOTAL,
          outflowToClient: TOTAL + 1,
          outflowToProvider: 0,
          outflowToPlatform: 0,
        },
        payouts: { toClient: TOTAL + 1, toProvider: 0 },
      });

      expect(checksOf(payment)).toContain(
        ReconciliationCheck.OUTFLOW_EXCEEDS_INFLOW,
      );
    });

    it('flags a held payment that already lost money', () => {
      const payment = held({
        ledger: {
          inflow: TOTAL,
          outflowToClient: 0,
          outflowToProvider: PROVIDER_SHARE,
          outflowToPlatform: 0,
        },
        payouts: { toClient: 0, toProvider: PROVIDER_SHARE },
      });

      expect(checksOf(payment)).toEqual([ReconciliationCheck.BALANCE_MISMATCH]);
    });

    it('flags a refunded payment with money left in escrow', () => {
      const payment = held({
        status: PaymentStatus.REFUNDED,
        depositStatus: DepositStatus.RETURNED,
        bookingStatus: BookingStatus.CANCELLED,
        ledger: {
          inflow: TOTAL,
          outflowToClient: TOTAL - DEPOSIT,
          outflowToProvider: 0,
          outflowToPlatform: 0,
        },
        payouts: { toClient: TOTAL - DEPOSIT, toProvider: 0 },
      });

      expect(checksOf(payment)).toEqual([ReconciliationCheck.BALANCE_MISMATCH]);
    });

    it('flags a released rental whose deposit left without being returned or claimed', () => {
      const payment = released({
        ledger: {
          inflow: TOTAL,
          outflowToClient: DEPOSIT,
          outflowToProvider: PROVIDER_SHARE,
          outflowToPlatform: PLATFORM_SHARE,
        },
        payouts: { toClient: DEPOSIT, toProvider: PROVIDER_SHARE },
      });

      expect(checksOf(payment)).toEqual([ReconciliationCheck.BALANCE_MISMATCH]);
    });

    it('says how much is left and how much should be', () => {
      const [finding] = reconcilePayment(
        held({
          ledger: {
            inflow: TOTAL,
            outflowToClient: 0,
            outflowToProvider: PROVIDER_SHARE,
            outflowToPlatform: 0,
          },
          payouts: { toClient: 0, toProvider: PROVIDER_SHARE },
        }),
      );

      expect(finding).toEqual({
        paymentId: 'payment-uuid-001',
        receiptNumber: 'ZUNO-1-0001',
        check: ReconciliationCheck.BALANCE_MISMATCH,
        detail:
          'Restam 5900.00 MZN no escrow e, com o pagamento HELD e o depósito HELD, deviam restar 9950.00 MZN.',
      });
    });
  });

  describe('payouts', () => {
    it('flags money that left for the provider without a payout', () => {
      const payment = released({ payouts: { toClient: 0, toProvider: 0 } });

      expect(checksOf(payment)).toEqual([
        ReconciliationCheck.PROVIDER_PAYOUTS_MISMATCH,
      ]);
    });

    it('flags a payout to the client that the ledger never recorded', () => {
      const payment = released({
        payouts: { toClient: DEPOSIT, toProvider: PROVIDER_SHARE },
      });

      expect(checksOf(payment)).toEqual([
        ReconciliationCheck.CLIENT_PAYOUTS_MISMATCH,
      ]);
    });
  });

  describe('the booking', () => {
    it.each<[string, Partial<PaymentSnapshot>]>([
      [
        'money held in a cancelled booking',
        { bookingStatus: BookingStatus.CANCELLED },
      ],
      [
        'money held in an expired booking',
        { bookingStatus: BookingStatus.EXPIRED },
      ],
      [
        'money held in a cancelled service booking',
        {
          bookingStatus: null,
          serviceBookingStatus: ServiceBookingStatus.CANCELLED,
        },
      ],
      [
        'a payment with no booking at all',
        { bookingStatus: null, serviceBookingStatus: null },
      ],
    ])('flags %s', (_label, overrides) => {
      expect(checksOf(held(overrides))).toContain(
        ReconciliationCheck.RESERVATION_STATE_MISMATCH,
      );
    });

    it('flags a released payment whose booking is still waiting for delivery', () => {
      const payment = released({ bookingStatus: BookingStatus.CONFIRMED });

      expect(checksOf(payment)).toEqual([
        ReconciliationCheck.RESERVATION_STATE_MISMATCH,
      ]);
    });
  });

  describe('the deposit', () => {
    it('flags a held payment whose deposit is not marked as held', () => {
      const payment = held({ depositStatus: DepositStatus.NONE });

      expect(checksOf(payment)).toContain(
        ReconciliationCheck.DEPOSIT_STATE_MISMATCH,
      );
    });

    it('flags a deposit status on a payment that has no deposit', () => {
      const payment = held({ depositAmount: 0 });

      expect(checksOf(payment)).toContain(
        ReconciliationCheck.DEPOSIT_STATE_MISMATCH,
      );
    });

    it('flags a deposit still held after the payment was refunded', () => {
      const payment = held({
        status: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED,
        ledger: {
          inflow: TOTAL,
          outflowToClient: TOTAL,
          outflowToProvider: 0,
          outflowToPlatform: 0,
        },
        payouts: { toClient: TOTAL, toProvider: 0 },
      });

      expect(checksOf(payment)).toContain(
        ReconciliationCheck.DEPOSIT_STATE_MISMATCH,
      );
    });
  });

  describe('a rental split by a dispute', () => {
    it('flags a split rental whose booking went back to waiting for delivery', () => {
      expect(
        checksOf(split({ bookingStatus: BookingStatus.CONFIRMED })),
      ).toEqual([ReconciliationCheck.RESERVATION_STATE_MISMATCH]);
    });

    it('flags a split rental whose deposit left without being returned or claimed', () => {
      const payment = split({
        ledger: {
          inflow: TOTAL,
          outflowToClient: SPLIT_REFUND + DEPOSIT,
          outflowToProvider: SPLIT_PROVIDER_SHARE,
          outflowToPlatform: PLATFORM_SHARE,
        },
        payouts: {
          toClient: SPLIT_REFUND + DEPOSIT,
          toProvider: SPLIT_PROVIDER_SHARE,
        },
      });

      expect(checksOf(payment)).toContain(ReconciliationCheck.BALANCE_MISMATCH);
    });
  });

  it('reports every problem of a payment, not only the first', () => {
    const payment = held({
      bookingStatus: BookingStatus.CANCELLED,
      depositStatus: DepositStatus.NONE,
      ledger: {
        inflow: 0,
        outflowToClient: 0,
        outflowToProvider: 0,
        outflowToPlatform: 0,
      },
    });

    expect(checksOf(payment)).toEqual([
      ReconciliationCheck.INFLOW_MISMATCH,
      ReconciliationCheck.BALANCE_MISMATCH,
      ReconciliationCheck.RESERVATION_STATE_MISMATCH,
      ReconciliationCheck.DEPOSIT_STATE_MISMATCH,
    ]);
  });
});
