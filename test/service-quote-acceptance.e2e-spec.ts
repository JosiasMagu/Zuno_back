import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { createServiceQuote } from './helpers/service-flow';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Orçamento de 5000 MZN: o cliente paga mais 10% de taxa e o provider
// recebe o valor menos 10%. Com urgência o orçamento sobe 30%.
const SERVICE_AMOUNT = 5000;
const PLATFORM_FEE = 500;
const TOTAL_CHARGED = 5500;
const PROVIDER_PAYOUT = 4500;
const URGENT_SERVICE_AMOUNT = 6500;
const URGENT_TOTAL_CHARGED = 7150;

describe('Service quote acceptance E2E', () => {
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

  function acceptAs(token: string, quoteId: string) {
    return request(actors.httpServer)
      .patch(`/api/v1/service-quotes/${quoteId}/accept`)
      .set(authHeader(token))
      .send({});
  }

  function readQuote(quoteId: string) {
    return prisma().serviceQuote.findUniqueOrThrow({ where: { id: quoteId } });
  }

  it('creates the service booking and its pending payment', async () => {
    const { requestId, quoteId } = await createServiceQuote(actors);

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(200);
    expect(response.body.data.quote.status).toBe('ACCEPTED');
    const { serviceBookingId, paymentId } = response.body.data as {
      serviceBookingId: string;
      paymentId: string;
    };

    expect((await readQuote(quoteId)).status).toBe('ACCEPTED');
    const serviceRequest = await prisma().serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(serviceRequest.status).toBe('ACCEPTED');

    const booking = await prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });
    expect(booking).toMatchObject({
      clientId: actors.client.userId,
      providerId: actors.provider.userId,
      requestId,
      quoteId,
      isUrgent: false,
      status: 'PENDING',
    });
    expect(Number(booking.serviceAmount)).toBe(SERVICE_AMOUNT);
    expect(Number(booking.platformFee)).toBe(PLATFORM_FEE);
    expect(Number(booking.totalAmount)).toBe(TOTAL_CHARGED);

    const payment = await prisma().payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(payment).toMatchObject({
      serviceBookingId,
      bookingId: null,
      clientId: actors.client.userId,
      ownerId: actors.provider.userId,
      method: 'MPESA',
      status: 'PENDING',
    });
    expect(Number(payment.rentalAmount)).toBe(SERVICE_AMOUNT);
    expect(Number(payment.depositAmount)).toBe(0);
    expect(Number(payment.platformFee)).toBe(PLATFORM_FEE);
    expect(Number(payment.totalCharged)).toBe(TOTAL_CHARGED);
    expect(Number(payment.ownerPayout)).toBe(PROVIDER_PAYOUT);
    expect(payment.receiptNumber).toMatch(/^ZUNO-/);

    const audits = await prisma().auditLog.findMany({
      where: { targetId: { in: [quoteId, paymentId] } },
      select: { action: true, targetId: true, amount: true },
    });
    expect(audits.map((a) => `${a.action}:${Number(a.amount)}`).sort()).toEqual(
      expect.arrayContaining([
        `PAYMENT_INITIATED:${TOTAL_CHARGED}`,
        `SERVICE_QUOTE_ACCEPTED:${TOTAL_CHARGED}`,
      ]),
    );
  });

  it('carries the urgency and its surcharge into the booking', async () => {
    const { quoteId } = await createServiceQuote(actors, { urgent: true });

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(200);
    const booking = await prisma().serviceBooking.findUniqueOrThrow({
      where: { id: response.body.data.serviceBookingId as string },
    });
    expect(booking.isUrgent).toBe(true);
    expect(Number(booking.serviceAmount)).toBe(URGENT_SERVICE_AMOUNT);
    expect(Number(booking.totalAmount)).toBe(URGENT_TOTAL_CHARGED);
  });

  it('returns 403 to the provider who sent the quote', async () => {
    const { quoteId } = await createServiceQuote(actors);

    const response = await acceptAs(actors.provider.accessToken, quoteId);

    expect(response.status).toBe(403);
    expect((await readQuote(quoteId)).status).toBe('PENDING');
  });

  it('returns 403 to a client who did not make the request', async () => {
    const { quoteId } = await createServiceQuote(actors);
    const outsider = await loginAsOutsider(app);

    const response = await acceptAs(outsider.accessToken, quoteId);

    expect(response.status).toBe(403);
  });

  it('returns 400 on a second acceptance and creates only one booking', async () => {
    const { quoteId } = await createServiceQuote(actors);
    await acceptAs(actors.client.accessToken, quoteId).expect(200);

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(400);
    expect(await prisma().serviceBooking.count()).toBe(1);
    expect(await prisma().payment.count()).toBe(1);
  });

  it('returns 400 when the provider has withdrawn the quote', async () => {
    const { quoteId } = await createServiceQuote(actors);
    await request(actors.httpServer)
      .patch(`/api/v1/service-quotes/${quoteId}/withdraw`)
      .set(authHeader(actors.provider.accessToken))
      .send({})
      .expect(200);

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(400);
    expect(await prisma().serviceBooking.count()).toBe(0);
  });

  it('returns 400 when the quote has expired', async () => {
    const { quoteId } = await createServiceQuote(actors);
    await prisma().serviceQuote.update({
      where: { id: quoteId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(400);
    expect((await readQuote(quoteId)).status).toBe('PENDING');
  });

  it('returns 400 when the request is no longer open', async () => {
    const { requestId, quoteId } = await createServiceQuote(actors);
    await prisma().serviceRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED' },
    });

    const response = await acceptAs(actors.client.accessToken, quoteId);

    expect(response.status).toBe(400);
    expect(await prisma().serviceBooking.count()).toBe(0);
  });

  it('returns 404 for an unknown quote', async () => {
    const response = await acceptAs(actors.client.accessToken, randomUUID());

    expect(response.status).toBe(404);
  });
});
