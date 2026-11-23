import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginViaApi, LoginResult } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  initiatePayment,
  openPaymentDispute,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';
import { hashTestPassword, TEST_PASSWORD } from './helpers/seed-test-data';
import { createHeldServiceBooking } from './helpers/service-flow';

// Aluguer de 3 dias a 1500 MZN por dia, com 5000 de depósito.
const TOTAL = 9950;
const REFERENCE = 'QGH7RT51XK';
const REASON = 'A referência era do pagamento da reserva seguinte na fila.';

describe('Voiding a mistaken payment confirmation E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let otherAdmin: LoginResult;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
    await prisma().user.create({
      data: {
        phone: '+258840000903',
        email: 'admin2-e2e@zuno.co.mz',
        name: 'Segundo Admin E2E',
        passwordHash: await hashTestPassword(),
        role: 'ADMIN',
        isVerified: true,
        isActive: true,
      },
    });
    otherAdmin = await loginViaApi(app, '+258840000903', TEST_PASSWORD);
  });

  // No fim de cada teste, o dinheiro tem de bater certo.
  afterEach(() => expectMoneyReconciles(app));

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const markHeld = (
    paymentId: string,
    mpesaReference = REFERENCE,
    receivedAmount = TOTAL,
  ) =>
    request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(actors.admin.accessToken))
      .send({ mpesaReference, receivedAmount, payerMsisdn: '+258840000902' });

  const voidHoldAs = (
    who: { accessToken: string },
    paymentId: string,
    reason: string = REASON,
  ) =>
    request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/void-hold`)
      .set(authHeader(who.accessToken))
      .send({ reason });

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const readLedger = async (paymentId: string) => {
    const entries = await prisma().ledgerEntry.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });
    return entries.map(
      ({ direction, party, amount }) =>
        `${direction}:${party}:${Number(amount)}`,
    );
  };

  /** Reserva confirmada, com o pagamento iniciado e ainda por entrar. */
  async function createPendingPayment() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);
    return { bookingId, paymentId };
  }

  /** O primeiro admin dá por engano o pagamento como recebido. */
  async function createMistakenHold() {
    const created = await createPendingPayment();
    await markHeld(created.paymentId).expect(200);
    return created;
  }

  it('puts the payment back to unpaid and reverses the entry in the ledger', async () => {
    const { bookingId, paymentId } = await createMistakenHold();

    const response = await voidHoldAs(otherAdmin, paymentId);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('PENDING');
    expect(await readPayment(paymentId)).toMatchObject({
      status: 'PENDING',
      heldAt: null,
      heldById: null,
      mpesaReference: null,
      payerMsisdn: null,
      depositStatus: 'NONE',
    });
    // A entrada errada fica no ledger, com o estorno ao lado.
    expect(await readLedger(paymentId)).toEqual([
      `INFLOW:CLIENT:${TOTAL}`,
      `OUTFLOW:REVERSAL:${TOTAL}`,
    ]);
    const booking = await prisma().booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('records who voided it, who had confirmed it and why', async () => {
    const { paymentId } = await createMistakenHold();

    await voidHoldAs(otherAdmin, paymentId).expect(200);

    const audit = await prisma().auditLog.findFirstOrThrow({
      where: { action: 'PAYMENT_HOLD_VOIDED', targetId: paymentId },
    });
    expect(audit.actorId).toBe(otherAdmin.userId);
    expect(Number(audit.amount)).toBe(TOTAL);
    expect(audit.metadata).toEqual({
      reason: REASON,
      confirmedBy: actors.admin.userId,
      mpesaReference: REFERENCE,
    });
  });

  it('frees the reference for the payment the money was really for', async () => {
    const wrong = await createMistakenHold();
    const right = await createPendingPayment();
    await markHeld(right.paymentId).expect(409);

    await voidHoldAs(otherAdmin, wrong.paymentId).expect(200);

    await markHeld(right.paymentId).expect(200);
    expect((await readPayment(right.paymentId)).mpesaReference).toBe(REFERENCE);
  });

  it('lets the same payment be confirmed again once the money does come in', async () => {
    const { paymentId } = await createMistakenHold();
    await voidHoldAs(otherAdmin, paymentId).expect(200);

    await markHeld(paymentId, 'QGH7RT99ZZ').expect(200);

    expect((await readPayment(paymentId)).status).toBe('HELD');
    expect(await readLedger(paymentId)).toEqual([
      `INFLOW:CLIENT:${TOTAL}`,
      `OUTFLOW:REVERSAL:${TOTAL}`,
      `INFLOW:CLIENT:${TOTAL}`,
    ]);
  });

  it('gives a service booking a new deadline to be paid', async () => {
    const { serviceBookingId, paymentId } =
      await createHeldServiceBooking(actors);

    await voidHoldAs(otherAdmin, paymentId).expect(200);

    const booking = await prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });
    expect(booking.status).toBe('PENDING');
    expect(booking.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect((await readPayment(paymentId)).status).toBe('PENDING');
  });

  describe('refusals', () => {
    it('returns 403 to the admin who confirmed the money coming in', async () => {
      const { paymentId } = await createMistakenHold();

      const response = await voidHoldAs(actors.admin, paymentId);

      expect(response.status).toBe(403);
      expect(response.body.errorCode).toBe('MONEY_CONTROL_VIOLATION');
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 403 to an account that is not an admin', async () => {
      const { paymentId } = await createMistakenHold();

      await voidHoldAs(actors.client, paymentId).expect(403);
    });

    it('returns 400 without a real reason', async () => {
      const { paymentId } = await createMistakenHold();

      await voidHoldAs(otherAdmin, paymentId, 'engano').expect(400);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 400 once the client confirmed the delivery', async () => {
      const { paymentId } = await createMistakenHold();
      await releasePayment(actors, paymentId);

      const response = await voidHoldAs(otherAdmin, paymentId);

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('RELEASED');
    });

    it('returns 400 while a dispute is open', async () => {
      const { bookingId, paymentId } = await createMistakenHold();
      await openPaymentDispute(actors, { bookingId, paymentId });

      const response = await voidHoldAs(otherAdmin, paymentId);

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 400 while the confirmation left excess money aside to be returned', async () => {
      const { paymentId } = await createPendingPayment();
      await markHeld(paymentId, REFERENCE, TOTAL + 50).expect(200);

      const response = await voidHoldAs(otherAdmin, paymentId);

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 400 for a payment that was never confirmed', async () => {
      const { paymentId } = await createPendingPayment();

      await voidHoldAs(otherAdmin, paymentId).expect(400);
    });
  });
});
