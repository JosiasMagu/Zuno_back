import {
  DepositStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
} from '@prisma/client';

import {
  CancelledPaymentOutcome,
  EscrowRefundService,
} from './escrow-refund.service';
import { LedgerService } from './ledger.service';
import { PayoutsService } from './payouts.service';

const PAYMENT_ID = 'payment-uuid-001';
const CLIENT_ID = 'client-uuid-001';
const ADMIN_ID = 'admin-uuid-001';

const ledgerMock = { record: jest.fn() };
const payoutsMock = { createPending: jest.fn() };
const txMock = { payment: { findUnique: jest.fn(), update: jest.fn() } };
const tx = txMock as unknown as Prisma.TransactionClient;

const CONTEXT = { actorId: ADMIN_ID, reason: 'Reembolso total ao cliente.' };

const makePayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  status: PaymentStatus.HELD,
  totalCharged: new Prisma.Decimal(5500),
  depositStatus: DepositStatus.NONE,
  clientId: CLIENT_ID,
  ...overrides,
});

describe('EscrowRefundService', () => {
  let service: EscrowRefundService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new EscrowRefundService(
      ledgerMock as unknown as LedgerService,
      payoutsMock as unknown as PayoutsService,
    );
  });

  describe('refundInFull', () => {
    it('takes everything the client paid out of escrow, under the given reason', async () => {
      await service.refundInFull(tx, makePayment(), CONTEXT);

      expect(ledgerMock.record).toHaveBeenCalledWith(tx, {
        paymentId: PAYMENT_ID,
        direction: LedgerDirection.OUTFLOW,
        party: LedgerParty.CLIENT,
        amount: 5500,
        reason: 'Reembolso total ao cliente.',
        actorId: ADMIN_ID,
      });
    });

    it('creates the refund payout for the client', async () => {
      await service.refundInFull(tx, makePayment(), CONTEXT);

      expect(payoutsMock.createPending).toHaveBeenCalledWith(tx, {
        paymentId: PAYMENT_ID,
        recipientId: CLIENT_ID,
        kind: PayoutKind.CLIENT_REFUND,
        amount: 5500,
      });
    });

    it('closes the payment as refunded, with nothing left for the provider', async () => {
      await service.refundInFull(tx, makePayment(), CONTEXT);

      expect(txMock.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt: expect.any(Date) as Date,
          refundAmount: 5500,
          ownerPayout: 0,
        },
      });
    });

    it('marks a held deposit as returned', async () => {
      await service.refundInFull(
        tx,
        makePayment({ depositStatus: DepositStatus.HELD }),
        CONTEXT,
      );

      expect(txMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.RETURNED,
            depositReleasedAt: expect.any(Date) as Date,
          }) as object,
        }),
      );
    });

    it('records the system as actor when nobody asked for the refund', async () => {
      await service.refundInFull(tx, makePayment(), {
        ...CONTEXT,
        actorId: null,
      });

      expect(ledgerMock.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ actorId: null }),
      );
    });
  });

  describe('settleCancelled', () => {
    it('voids a payment whose money never arrived', async () => {
      txMock.payment.findUnique.mockResolvedValue(
        makePayment({ status: PaymentStatus.PENDING }),
      );

      const outcome = await service.settleCancelled(tx, PAYMENT_ID, CONTEXT);

      expect(outcome).toBe(CancelledPaymentOutcome.VOIDED);
      expect(txMock.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: { status: PaymentStatus.FAILED },
      });
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(payoutsMock.createPending).not.toHaveBeenCalled();
    });

    it('refunds in full a payment held in escrow', async () => {
      txMock.payment.findUnique.mockResolvedValue(makePayment());

      const outcome = await service.settleCancelled(tx, PAYMENT_ID, CONTEXT);

      expect(outcome).toBe(CancelledPaymentOutcome.REFUNDED);
      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(payoutsMock.createPending).toHaveBeenCalledTimes(1);
    });

    it.each([
      PaymentStatus.FAILED,
      PaymentStatus.RELEASED,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
    ])('leaves a %s payment alone', async (status) => {
      txMock.payment.findUnique.mockResolvedValue(makePayment({ status }));

      const outcome = await service.settleCancelled(tx, PAYMENT_ID, CONTEXT);

      expect(outcome).toBe(CancelledPaymentOutcome.NOTHING_TO_SETTLE);
      expect(txMock.payment.update).not.toHaveBeenCalled();
      expect(ledgerMock.record).not.toHaveBeenCalled();
    });

    it('has nothing to settle when the payment does not exist', async () => {
      txMock.payment.findUnique.mockResolvedValue(null);

      const outcome = await service.settleCancelled(tx, PAYMENT_ID, CONTEXT);

      expect(outcome).toBe(CancelledPaymentOutcome.NOTHING_TO_SETTLE);
    });
  });
});
