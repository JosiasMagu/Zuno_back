import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

describe('Payment initiation E2E', () => {
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

  function initiateAs(token: string, bookingId: string, method = 'MPESA') {
    return request(actors.httpServer)
      .post(`/api/v1/payments/booking/${bookingId}/initiate`)
      .set(authHeader(token))
      .send({ method });
  }

  async function createConfirmedBooking() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);

    return bookingId;
  }

  it('creates a pending payment with the amounts of the booking', async () => {
    const bookingId = await createConfirmedBooking();

    const response = await initiateAs(actors.client.accessToken, bookingId);

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('PENDING');
    const paymentId = response.body.data.id as string;

    const payment = await prisma().payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(payment).toMatchObject({
      bookingId,
      clientId: actors.client.userId,
      ownerId: actors.provider.userId,
      currency: 'MZN',
      method: 'MPESA',
      status: 'PENDING',
    });
    expect(Number(payment.rentalAmount)).toBe(4500);
    expect(Number(payment.platformFee)).toBe(450);
    expect(Number(payment.depositAmount)).toBe(5000);
    expect(Number(payment.depositHeldAmount)).toBe(5000);
    expect(Number(payment.totalCharged)).toBe(9950);
    expect(Number(payment.ownerPayout)).toBe(4050);
    expect(payment.receiptNumber).toMatch(/^ZUNO-/);

    const audits = await prisma().auditLog.findMany({
      where: { targetId: paymentId, action: 'PAYMENT_INITIATED' },
    });
    expect(audits).toHaveLength(1);
    expect(Number(audits[0].amount)).toBe(9950);
    expect(audits[0].metadata).toEqual({
      bookingId,
      method: 'MPESA',
      receiptNumber: payment.receiptNumber,
    });
  });

  it('returns 403 to the provider of the booking', async () => {
    const bookingId = await createConfirmedBooking();

    const response = await initiateAs(actors.provider.accessToken, bookingId);

    expect(response.status).toBe(403);
    expect(await prisma().payment.count()).toBe(0);
  });

  it('returns 403 to a client who did not make the booking', async () => {
    const bookingId = await createConfirmedBooking();
    const outsider = await loginAsOutsider(app);

    const response = await initiateAs(outsider.accessToken, bookingId);

    expect(response.status).toBe(403);
  });

  it('returns 400 while the provider has not confirmed the booking', async () => {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);

    const response = await initiateAs(actors.client.accessToken, bookingId);

    expect(response.status).toBe(400);
    expect(await prisma().payment.count()).toBe(0);
  });

  it('returns 400 when the booking already has a payment', async () => {
    const bookingId = await createConfirmedBooking();
    await initiateAs(actors.client.accessToken, bookingId).expect(201);

    const response = await initiateAs(actors.client.accessToken, bookingId);

    expect(response.status).toBe(400);
    expect(await prisma().payment.count()).toBe(1);
  });

  it('returns 400 for a payment method the platform does not support', async () => {
    const bookingId = await createConfirmedBooking();

    const response = await initiateAs(
      actors.client.accessToken,
      bookingId,
      'BITCOIN',
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown booking', async () => {
    const response = await initiateAs(actors.client.accessToken, randomUUID());

    expect(response.status).toBe(404);
  });
});
