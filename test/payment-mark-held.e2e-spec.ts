import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  initiatePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readInflows } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Aluguer de 3 dias a 1500 MZN por dia: 4500 de aluguer e 450 de taxa, mais
// o depósito quando existe.
const TOTAL_WITH_DEPOSIT = 9950;
const TOTAL_WITHOUT_DEPOSIT = 4950;

const PAYER = '+258840000902';

interface Receipt {
  mpesaReference?: string;
  receivedAmount?: number;
  payerMsisdn?: string;
}

describe('Payment mark-held E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  // No fim de cada teste, o dinheiro tem de bater certo.
  afterEach(() => expectMoneyReconciles(app));

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  /** O que o admin leu no extracto: por omissão, o total com depósito e uma referência nova. */
  function receipt(overrides: Receipt = {}): Receipt {
    return {
      mpesaReference: `REF${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      receivedAmount: TOTAL_WITH_DEPOSIT,
      payerMsisdn: PAYER,
      ...overrides,
    };
  }

  function markHeldAs(token: string, paymentId: string, body = receipt()) {
    return request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(token))
      .send(body);
  }

  const markHeld = (paymentId: string, body?: Receipt) =>
    markHeldAs(actors.admin.accessToken, paymentId, body);

  function readPayment(paymentId: string) {
    return prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  /** Reserva confirmada com o pagamento iniciado, ainda por entrar. */
  async function createPendingPayment(depositAmount?: number) {
    const equipmentId = await createApprovedEquipment(actors, {
      depositAmount,
    });
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);

    return { bookingId, paymentId };
  }

  it('holds the payment and records the money entering escrow', async () => {
    const { paymentId } = await createPendingPayment();

    const response = await markHeld(paymentId);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('HELD');

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('HELD');
    expect(payment.heldAt).not.toBeNull();
    expect(payment.depositStatus).toBe('HELD');
    expect(await readInflows(paymentId)).toEqual([
      `CLIENT:${TOTAL_WITH_DEPOSIT}`,
    ]);
  });

  it('marks no deposit as held when the booking has none', async () => {
    const { paymentId } = await createPendingPayment(0);

    const response = await markHeld(
      paymentId,
      receipt({ receivedAmount: TOTAL_WITHOUT_DEPOSIT }),
    );

    expect(response.status).toBe(200);
    expect((await readPayment(paymentId)).depositStatus).toBe('NONE');
    expect(await readInflows(paymentId)).toEqual([
      `CLIENT:${TOTAL_WITHOUT_DEPOSIT}`,
    ]);
  });

  describe('what the admin read on the statement', () => {
    it('is stored with the payment, in one format', async () => {
      const { paymentId } = await createPendingPayment();

      await markHeld(
        paymentId,
        receipt({
          mpesaReference: '  chk7h3abcd ',
          payerMsisdn: '84 000 0902',
        }),
      ).expect(200);

      const payment = await readPayment(paymentId);
      expect(payment.mpesaReference).toBe('CHK7H3ABCD');
      expect(payment.payerMsisdn).toBe(PAYER);
      expect(Number(payment.receivedAmount)).toBe(TOTAL_WITH_DEPOSIT);
    });

    it('goes to the audit log with the amount', async () => {
      const { paymentId } = await createPendingPayment();

      await markHeld(
        paymentId,
        receipt({ mpesaReference: 'CHK7H3ABCD' }),
      ).expect(200);

      const audits = await prisma().auditLog.findMany({
        where: { targetId: paymentId, action: 'PAYMENT_MARKED_HELD' },
      });
      expect(audits).toHaveLength(1);
      expect(Number(audits[0].amount)).toBe(TOTAL_WITH_DEPOSIT);
      expect(audits[0].metadata).toEqual({
        provider: 'manual',
        mpesaReference: 'CHK7H3ABCD',
        payerMsisdn: PAYER,
        declaredReference: null,
        receivedAmount: TOTAL_WITH_DEPOSIT,
        excess: 0,
      });
    });

    it.each([
      ['no reference', { mpesaReference: undefined }],
      ['a reference that is too short', { mpesaReference: 'AB1' }],
      ['no amount', { receivedAmount: undefined }],
      ['an amount of zero', { receivedAmount: 0 }],
      ['no payer number', { payerMsisdn: undefined }],
      ['a payer number that is not a mobile', { payerMsisdn: '21123456' }],
    ])('returns 400 with %s', async (_case, missing: Receipt) => {
      const { paymentId } = await createPendingPayment();

      const response = await markHeld(paymentId, receipt(missing));

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('PENDING');
      expect(await readInflows(paymentId)).toEqual([]);
    });
  });

  describe('amount received', () => {
    it.each([TOTAL_WITH_DEPOSIT - 1, TOTAL_WITH_DEPOSIT - 0.01, 4950])(
      'returns 400 for %p when the total is 9950, and nothing enters escrow',
      async (receivedAmount) => {
        const { bookingId, paymentId } = await createPendingPayment();

        const response = await markHeld(paymentId, receipt({ receivedAmount }));

        expect(response.status).toBe(400);
        expect(response.body.errorCode).toBe('PAYMENT_AMOUNT_MISMATCH');
        const payment = await readPayment(paymentId);
        expect(payment.status).toBe('PENDING');
        expect(payment.mpesaReference).toBeNull();
        expect(await readInflows(paymentId)).toEqual([]);
        const booking = await prisma().booking.findUniqueOrThrow({
          where: { id: bookingId },
        });
        expect(booking.expiresAt).not.toBeNull();
      },
    );
  });

  describe('more than the total', () => {
    it('holds the total and keeps the excess aside, to be returned to the payer', async () => {
      const { paymentId } = await createPendingPayment();

      await markHeld(
        paymentId,
        receipt({
          mpesaReference: 'XCS5PAID01',
          receivedAmount: TOTAL_WITH_DEPOSIT + 0.5,
        }),
      ).expect(200);

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('HELD');
      expect(Number(payment.receivedAmount)).toBe(TOTAL_WITH_DEPOSIT);
      const inflows = await prisma().ledgerEntry.findMany({
        where: { paymentId, direction: 'INFLOW' },
      });
      expect(inflows.map(({ amount }) => Number(amount))).toEqual([
        TOTAL_WITH_DEPOSIT,
      ]);
      const aside = await prisma().unallocatedFunds.findMany({
        where: { paymentId },
      });
      expect(aside).toHaveLength(1);
      expect(aside[0]).toMatchObject({
        reason: 'OVERPAYMENT',
        status: 'OPEN',
        providerReference: 'XCS5PAID01',
        payerMsisdn: PAYER,
      });
      expect(Number(aside[0].amount)).toBe(0.5);
    });
  });

  describe('M-Pesa reference', () => {
    it('returns 409 when it already closed another payment', async () => {
      const first = await createPendingPayment();
      const second = await createPendingPayment();
      await markHeld(
        first.paymentId,
        receipt({ mpesaReference: 'CHK7H3ABCD' }),
      ).expect(200);

      const response = await markHeld(
        second.paymentId,
        receipt({ mpesaReference: 'chk7h3abcd' }),
      );

      expect(response.status).toBe(409);
      expect(response.body.errorCode).toBe('PAYMENT_REFERENCE_ALREADY_USED');
      expect((await readPayment(second.paymentId)).status).toBe('PENDING');
      expect(await readInflows(second.paymentId)).toEqual([]);
    });

    it('closes one payment when two requests arrive with it at the same time', async () => {
      const first = await createPendingPayment();
      const second = await createPendingPayment();
      const sameTransfer = receipt({ mpesaReference: 'CHK7H3ABCD' });
      // Abre primeiro as ligações à base, para os dois pedidos se cruzarem.
      await Promise.all(
        [first, second].map(({ paymentId }) =>
          request(actors.httpServer)
            .get(`/api/v1/payments/${paymentId}`)
            .set(authHeader(actors.admin.accessToken)),
        ),
      );

      const responses = await Promise.all([
        markHeld(first.paymentId, sameTransfer),
        markHeld(second.paymentId, sameTransfer),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
      const held = await prisma().payment.count({ where: { status: 'HELD' } });
      expect(held).toBe(1);
      const inflows = await prisma().ledgerEntry.count({
        where: { direction: 'INFLOW' },
      });
      expect(inflows).toBe(1);
    });
  });

  it('returns 403 to the client', async () => {
    const { paymentId } = await createPendingPayment();

    const response = await markHeldAs(actors.client.accessToken, paymentId);

    expect(response.status).toBe(403);
    expect((await readPayment(paymentId)).status).toBe('PENDING');
  });

  it('returns 400 on a second mark-held and records the money only once', async () => {
    const { paymentId } = await createPendingPayment();
    await markHeld(paymentId).expect(200);

    const response = await markHeld(paymentId);

    expect(response.status).toBe(400);
    expect(await readInflows(paymentId)).toHaveLength(1);
  });

  it('returns 400 when the booking was cancelled', async () => {
    const { bookingId, paymentId } = await createPendingPayment();
    await request(actors.httpServer)
      .patch(`/api/v1/bookings/${bookingId}/cancel`)
      .set(authHeader(actors.client.accessToken))
      .send({})
      .expect(200);

    const response = await markHeld(paymentId);

    expect(response.status).toBe(400);
    // O cancelamento já tinha anulado o pagamento que estava por entrar.
    expect((await readPayment(paymentId)).status).toBe('FAILED');
    expect(await readInflows(paymentId)).toEqual([]);
  });

  it('returns 404 for an unknown payment', async () => {
    const response = await markHeld(randomUUID());

    expect(response.status).toBe(404);
  });
});
