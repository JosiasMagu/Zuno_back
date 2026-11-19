import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PaymentsService } from '../src/modules/payments/services/payments.service';
import { ServiceBookingsService } from '../src/modules/services/services/service-bookings.service';
import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  createApprovedEquipment,
  openPaymentDispute,
  paymentReceipt,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import {
  acceptServiceQuote,
  createHeldServiceBooking,
  createServiceQuote,
} from './helpers/service-flow';
import { expectMoneyReconciles } from './helpers/reconciliation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Serviço de 5000 MZN: o cliente paga 5500 (com a taxa) e o provider recebe 4500.
const TOTAL_CHARGED = 5500;
const PROVIDER_PAYOUT = 4500;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// Os jobs estão desligados em NODE_ENV=test. Os testes chamam directamente o
// método que o scheduler chamaria.
describe('Service booking lifecycle E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let serviceBookings: ServiceBookingsService;
  let payments: PaymentsService;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    serviceBookings = app.get(ServiceBookingsService);
    payments = app.get(PaymentsService);
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

  const readBooking = (serviceBookingId: string) =>
    prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const auditsOf = (targetId: string) =>
    prisma().auditLog.findMany({
      where: { targetId },
      select: { action: true, actorId: true, metadata: true },
    });

  const strikesOfProvider = () =>
    prisma().providerStrike.findMany({
      where: { userId: actors.provider.userId },
    });

  function patchAs(token: string, path: string, body: object = {}) {
    return request(actors.httpServer)
      .patch(`/api/v1${path}`)
      .set(authHeader(token))
      .send(body);
  }

  const cancelAs = (token: string, serviceBookingId: string, reason?: string) =>
    patchAs(token, `/service-bookings/${serviceBookingId}/cancel`, { reason });

  const start = (serviceBookingId: string) =>
    patchAs(
      actors.provider.accessToken,
      `/service-bookings/${serviceBookingId}/start`,
    );

  const complete = (serviceBookingId: string) =>
    patchAs(
      actors.provider.accessToken,
      `/service-bookings/${serviceBookingId}/complete`,
    );

  const markHeld = async (paymentId: string) =>
    patchAs(
      actors.admin.accessToken,
      `/payments/${paymentId}/mark-held`,
      await paymentReceipt(paymentId),
    );

  /** Orçamento aceite: reserva por pagar. */
  async function createUnpaidBooking() {
    const { quoteId, requestId } = await createServiceQuote(actors);
    const booking = await acceptServiceQuote(actors, quoteId);
    return { ...booking, quoteId, requestId };
  }

  /** Serviço pago e já começado pelo provider. */
  async function createStartedBooking() {
    const booking = await createHeldServiceBooking(actors);
    await start(booking.serviceBookingId).expect(200);
    return booking;
  }

  /** Serviço que o provider já deu por concluído, com o dinheiro ainda retido. */
  async function createCompletedBooking() {
    const booking = await createStartedBooking();
    await complete(booking.serviceBookingId).expect(200);
    return booking;
  }

  describe('payment deadline', () => {
    it('gives an accepted quote 24 hours to be paid, and says so', async () => {
      const { quoteId } = await createServiceQuote(actors);

      const response = await patchAs(
        actors.client.accessToken,
        `/service-quotes/${quoteId}/accept`,
      ).expect(200);

      const payBy = new Date(response.body.data.payBy as string);
      const hoursToPay = (payBy.getTime() - Date.now()) / HOUR_MS;
      expect(hoursToPay).toBeGreaterThan(23.9);
      expect(hoursToPay).toBeLessThanOrEqual(24);

      const booking = await readBooking(
        response.body.data.serviceBookingId as string,
      );
      expect(booking.expiresAt).toEqual(payBy);
    });

    it('expires an unpaid booking after the deadline', async () => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { expiresAt: hoursAgo(1) },
      });

      const expired = await serviceBookings.expireUnpaid();

      expect(expired).toBe(1);
      const booking = await readBooking(serviceBookingId);
      expect(booking.status).toBe('EXPIRED');
      expect(booking.cancellationReason).toBe(
        'A reserva expirou porque não foi paga dentro do prazo.',
      );
      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await auditsOf(serviceBookingId)).toContainEqual({
        action: 'SERVICE_BOOKING_EXPIRED',
        actorId: 'system',
        metadata: { declaredReference: null },
      });
    });

    it('leaves alone a booking still inside its deadline', async () => {
      const { serviceBookingId } = await createUnpaidBooking();

      const expired = await serviceBookings.expireUnpaid();

      expect(expired).toBe(0);
      expect((await readBooking(serviceBookingId)).status).toBe('PENDING');
    });

    it('never expires a booking whose payment is in escrow', async () => {
      const { serviceBookingId } = await createHeldServiceBooking(actors);

      expect((await readBooking(serviceBookingId)).expiresAt).toBeNull();
      expect(await serviceBookings.expireUnpaid()).toBe(0);
    });

    it('keeps what the client declared when the admin did not confirm in time', async () => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();
      await patchAs(
        actors.client.accessToken,
        `/payments/${paymentId}/declare`,
        {
          mpesaReference: 'CHK7H3ABCD',
          payerMsisdn: '+258840000902',
        },
      ).expect(200);
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { expiresAt: hoursAgo(1) },
      });

      await serviceBookings.expireUnpaid();

      expect((await readBooking(serviceBookingId)).cancellationReason).toBe(
        'A reserva expirou porque o pagamento declarado não foi confirmado a tempo.',
      );
      expect(await auditsOf(serviceBookingId)).toContainEqual({
        action: 'SERVICE_BOOKING_EXPIRED',
        actorId: 'system',
        metadata: { declaredReference: 'CHK7H3ABCD' },
      });
    });

    it('refuses the money and the start once the booking expired', async () => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { expiresAt: hoursAgo(1) },
      });
      await serviceBookings.expireUnpaid();

      expect((await markHeld(paymentId)).status).toBe(400);
      await start(serviceBookingId).expect(400);
      expect((await readPayment(paymentId)).status).toBe('FAILED');
    });
  });

  describe('start and completion', () => {
    it('refuses the start before the payment is confirmed', async () => {
      const { serviceBookingId } = await createUnpaidBooking();

      await start(serviceBookingId).expect(400);

      expect((await readBooking(serviceBookingId)).status).toBe('PENDING');
    });

    it('refuses the client who tries to start the service', async () => {
      const { serviceBookingId } = await createHeldServiceBooking(actors);

      await patchAs(
        actors.client.accessToken,
        `/service-bookings/${serviceBookingId}/start`,
      ).expect(403);
    });

    it('tells the client until when the completed service can be confirmed', async () => {
      const { serviceBookingId } = await createStartedBooking();

      const response = await complete(serviceBookingId).expect(200);

      const booking = await readBooking(serviceBookingId);
      expect(booking.status).toBe('COMPLETED');
      expect(response.body.data.autoReleaseAt).toBe(
        new Date(
          (booking.completedAt as Date).getTime() + 3 * DAY_MS,
        ).toISOString(),
      );
    });

    it('refuses a second completion', async () => {
      const { serviceBookingId } = await createCompletedBooking();

      await complete(serviceBookingId).expect(400);
    });
  });

  describe('cancellation before the money arrives', () => {
    it.each([
      ['the client', () => actors.client.accessToken],
      ['the provider', () => actors.provider.accessToken],
      ['an admin', () => actors.admin.accessToken],
    ])('lets %s cancel and voids the payment', async (_label, token) => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();

      const response = await cancelAs(
        token(),
        serviceBookingId,
        ' Mudei de planos. ',
      );

      expect(response.status).toBe(200);
      const booking = await readBooking(serviceBookingId);
      expect(booking.status).toBe('CANCELLED');
      expect(booking.cancellationReason).toBe('Mudei de planos.');
      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await readOutflows(paymentId)).toEqual([]);
      expect(await readPayouts(paymentId)).toEqual([]);
      expect(await strikesOfProvider()).toEqual([]);
    });

    it('refuses the money for a booking that was cancelled', async () => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();
      await cancelAs(actors.client.accessToken, serviceBookingId).expect(200);

      expect((await markHeld(paymentId)).status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('FAILED');
    });
  });

  describe('cancellation of a paid service not yet started', () => {
    it('gives the client everything back when the client cancels', async () => {
      const { serviceBookingId, paymentId } =
        await createHeldServiceBooking(actors);

      const response = await cancelAs(
        actors.client.accessToken,
        serviceBookingId,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('CANCELLED');
      expect(response.body.data.payment.status).toBe('REFUNDED');
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('REFUNDED');
      expect(Number(payment.refundAmount)).toBe(TOTAL_CHARGED);
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${TOTAL_CHARGED}:PENDING`,
      ]);
      expect(await strikesOfProvider()).toEqual([]);
    });

    it('refunds the client and strikes the provider who cancels', async () => {
      const { serviceBookingId, paymentId } =
        await createHeldServiceBooking(actors);

      await cancelAs(actors.provider.accessToken, serviceBookingId).expect(200);

      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      const strikes = await strikesOfProvider();
      expect(strikes).toHaveLength(1);
      expect(strikes[0]).toMatchObject({
        serviceBookingId,
        bookingId: null,
        reason: 'Cancelamento de serviço já pago.',
      });
      expect(await auditsOf(actors.provider.userId)).toContainEqual({
        action: 'PROVIDER_STRIKE_ISSUED',
        actorId: actors.provider.userId,
        metadata: { serviceBookingId },
      });
    });

    it('refunds the client without striking anyone when an admin cancels', async () => {
      const { serviceBookingId, paymentId } =
        await createHeldServiceBooking(actors);

      await cancelAs(actors.admin.accessToken, serviceBookingId).expect(200);

      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await strikesOfProvider()).toEqual([]);
    });

    it('records who cancelled and what happened to the money', async () => {
      const { serviceBookingId } = await createHeldServiceBooking(actors);

      await cancelAs(
        actors.client.accessToken,
        serviceBookingId,
        'Já resolvi de outra forma.',
      ).expect(200);

      expect(await auditsOf(serviceBookingId)).toContainEqual({
        action: 'SERVICE_BOOKING_CANCELLED',
        actorId: actors.client.userId,
        metadata: {
          reason: 'Já resolvi de outra forma.',
          cancelledBy: 'CLIENT',
          paymentOutcome: 'REFUNDED',
        },
      });
    });

    it('refuses someone who is not part of the booking', async () => {
      const { serviceBookingId, paymentId } =
        await createHeldServiceBooking(actors);
      const outsider = await loginAsOutsider(app);

      await cancelAs(outsider.accessToken, serviceBookingId).expect(403);

      expect((await readPayment(paymentId)).status).toBe('HELD');
    });
  });

  describe('cancellation after the provider started', () => {
    it('refuses the client and points to the dispute', async () => {
      const { serviceBookingId, paymentId } = await createStartedBooking();

      const response = await cancelAs(
        actors.client.accessToken,
        serviceBookingId,
      );

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('SERVICE_BOOKING_IN_PROGRESS');
      expect((await readBooking(serviceBookingId)).status).toBe('IN_PROGRESS');
      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect(await readOutflows(paymentId)).toEqual([]);
    });

    it('lets the provider give up: full refund and a strike', async () => {
      const { serviceBookingId, paymentId } = await createStartedBooking();

      await cancelAs(actors.provider.accessToken, serviceBookingId).expect(200);

      expect((await readBooking(serviceBookingId)).status).toBe('CANCELLED');
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await strikesOfProvider()).toHaveLength(1);
    });

    it('lets an admin cancel with a full refund', async () => {
      const { serviceBookingId, paymentId } = await createStartedBooking();

      await cancelAs(actors.admin.accessToken, serviceBookingId).expect(200);

      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await strikesOfProvider()).toEqual([]);
    });

    it.each([
      ['the client', () => actors.client.accessToken],
      ['the provider', () => actors.provider.accessToken],
      ['an admin', () => actors.admin.accessToken],
    ])('refuses %s once the service is completed', async (_label, token) => {
      const { serviceBookingId, paymentId } = await createCompletedBooking();

      await cancelAs(token(), serviceBookingId).expect(400);

      expect((await readBooking(serviceBookingId)).status).toBe('COMPLETED');
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });
  });

  describe('third strike', () => {
    async function giveProviderTwoStrikes() {
      await prisma().providerStrike.createMany({
        data: [1, 2].map(() => ({
          userId: actors.provider.userId,
          reason: 'Cancelamento de reserva confirmada.',
        })),
      });
    }

    it('suspends the provider and pauses services and equipment alike', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const { serviceBookingId, requestId } = await createUnpaidBooking();
      const { paymentId } = await prisma()
        .payment.findFirstOrThrow({
          where: { serviceBookingId },
          select: { id: true },
        })
        .then(({ id }) => ({ paymentId: id }));
      expect((await markHeld(paymentId)).status).toBe(200);
      await giveProviderTwoStrikes();

      await cancelAs(actors.provider.accessToken, serviceBookingId).expect(200);

      const provider = await prisma().user.findUniqueOrThrow({
        where: { id: actors.provider.userId },
      });
      const daysSuspended =
        ((provider.listingsSuspendedUntil as Date).getTime() - Date.now()) /
        DAY_MS;
      expect(daysSuspended).toBeGreaterThan(29.9);
      expect(daysSuspended).toBeLessThanOrEqual(30);

      const { serviceId } = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const service = await prisma().service.findUniqueOrThrow({
        where: { id: serviceId },
      });
      const equipment = await prisma().equipment.findUniqueOrThrow({
        where: { id: equipmentId },
      });
      expect(service.isActive).toBe(false);
      expect(equipment.isAvailable).toBe(false);

      const audits = await auditsOf(actors.provider.userId);
      expect(audits.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          'PROVIDER_STRIKE_ISSUED',
          'PROVIDER_LISTINGS_SUSPENDED',
        ]),
      );

      // Enquanto durar a suspensão, o provider não reabre o serviço.
      await patchAs(
        actors.provider.accessToken,
        `/services/${serviceId}/toggle-availability`,
      ).expect(403);
      expect(
        (await prisma().service.findUniqueOrThrow({ where: { id: serviceId } }))
          .isActive,
      ).toBe(false);
    });
  });

  describe('automatic release', () => {
    async function letDaysPassSinceCompletion(
      serviceBookingId: string,
      days: number,
    ) {
      const completedAt = daysAgo(days);
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { completedAt },
      });
      return completedAt;
    }

    it('pays the provider 3 days after completion if the client says nothing', async () => {
      const { serviceBookingId, paymentId } = await createCompletedBooking();
      const completedAt = await letDaysPassSinceCompletion(
        serviceBookingId,
        3.1,
      );

      const released = await payments.autoReleaseDue();

      expect(released).toBe(1);
      expect((await readPayment(paymentId)).status).toBe('RELEASED');
      expect(await readPayouts(paymentId)).toEqual([
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
      // A data de conclusão continua a ser a do provider.
      expect((await readBooking(serviceBookingId)).completedAt).toEqual(
        completedAt,
      );
      expect(await auditsOf(paymentId)).toContainEqual({
        action: 'PAYMENT_AUTO_RELEASED',
        actorId: 'system',
        metadata: { reason: 'service_confirmation_window_expired' },
      });
    });

    it('waits while the 3 days have not passed', async () => {
      const { serviceBookingId, paymentId } = await createCompletedBooking();
      await letDaysPassSinceCompletion(serviceBookingId, 2.9);

      expect(await payments.autoReleaseDue()).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('never releases a service the provider has not completed', async () => {
      const { serviceBookingId, paymentId } = await createStartedBooking();
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { startedAt: daysAgo(30) },
      });
      await prisma().payment.update({
        where: { id: paymentId },
        data: { heldAt: daysAgo(30) },
      });

      expect(await payments.autoReleaseDue()).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('never releases a completed service under dispute', async () => {
      const { serviceBookingId, paymentId } = await createCompletedBooking();
      await openPaymentDispute(actors, { serviceBookingId, paymentId });
      await letDaysPassSinceCompletion(serviceBookingId, 10);

      expect(await payments.autoReleaseDue()).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('keeps the date the provider completed the service when the client releases', async () => {
      const { serviceBookingId, paymentId } = await createCompletedBooking();
      const completedAt = await letDaysPassSinceCompletion(serviceBookingId, 1);

      await patchAs(
        actors.client.accessToken,
        `/payments/${paymentId}/release`,
      ).expect(200);

      expect((await readBooking(serviceBookingId)).completedAt).toEqual(
        completedAt,
      );
    });
  });

  describe('accepting a quote', () => {
    const accept = (quoteId: string) =>
      patchAs(actors.client.accessToken, `/service-quotes/${quoteId}/accept`);

    const serviceOf = async (requestId: string) =>
      (
        await prisma().serviceRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).serviceId;

    it('keeps the date the client asked for, as information only', async () => {
      const { quoteId, requestId } = await createServiceQuote(actors);
      const preferredDate = new Date(Date.now() + 10 * DAY_MS);
      await prisma().serviceRequest.update({
        where: { id: requestId },
        data: { preferredDate },
      });

      const response = await accept(quoteId).expect(200);

      const booking = await readBooking(
        response.body.data.serviceBookingId as string,
      );
      expect(booking.scheduledFor).toEqual(preferredDate);
      // O prazo de pagamento não depende da data pedida.
      const hoursToPay =
        ((booking.expiresAt as Date).getTime() - Date.now()) / HOUR_MS;
      expect(hoursToPay).toBeLessThanOrEqual(24);
    });

    it('is refused when the service left the catalogue', async () => {
      const { quoteId, requestId } = await createServiceQuote(actors);
      await prisma().service.update({
        where: { id: await serviceOf(requestId) },
        data: { status: 'DELETED', isActive: false },
      });

      await accept(quoteId).expect(400);

      expect(await prisma().serviceBooking.count()).toBe(0);
      expect(await prisma().payment.count()).toBe(0);
    });

    it('is refused while the provider is suspended', async () => {
      const { quoteId } = await createServiceQuote(actors);
      await prisma().user.update({
        where: { id: actors.provider.userId },
        data: { listingsSuspendedUntil: new Date(Date.now() + DAY_MS) },
      });

      await accept(quoteId).expect(400);

      expect(await prisma().serviceBooking.count()).toBe(0);
    });

    it('is refused when the request expired, even before the job ran', async () => {
      const { quoteId, requestId } = await createServiceQuote(actors);
      await prisma().serviceRequest.update({
        where: { id: requestId },
        data: { expiresAt: hoursAgo(1) },
      });

      await accept(quoteId).expect(400);

      expect(await prisma().serviceBooking.count()).toBe(0);
    });

    it.each([
      ['the client rejects', () => actors.client.accessToken, 'reject'],
      ['the provider withdraws', () => actors.provider.accessToken, 'withdraw'],
    ])(
      'stays accepted when %s it afterwards',
      async (_label, token, action) => {
        const { quoteId } = await createUnpaidBooking();

        await patchAs(token(), `/service-quotes/${quoteId}/${action}`).expect(
          400,
        );

        const quote = await prisma().serviceQuote.findUniqueOrThrow({
          where: { id: quoteId },
        });
        expect(quote.status).toBe('ACCEPTED');
      },
    );
  });

  describe('requests arriving at the same time', () => {
    it('never leaves a withdrawn quote with a booking', async () => {
      const { quoteId } = await createServiceQuote(actors);

      const [accepted, withdrawn] = await Promise.all([
        patchAs(actors.client.accessToken, `/service-quotes/${quoteId}/accept`),
        patchAs(
          actors.provider.accessToken,
          `/service-quotes/${quoteId}/withdraw`,
        ),
      ]);

      expect([accepted.status, withdrawn.status].sort()).toEqual([200, 400]);
      const quote = await prisma().serviceQuote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      const bookings = await prisma().serviceBooking.count();
      expect([quote.status, bookings]).toEqual(
        accepted.status === 200 ? ['ACCEPTED', 1] : ['WITHDRAWN', 0],
      );
    });

    it('never leaves money held in a cancelled booking', async () => {
      const { serviceBookingId, paymentId } = await createUnpaidBooking();
      const receipt = await paymentReceipt(paymentId);

      await Promise.all([
        cancelAs(actors.client.accessToken, serviceBookingId),
        patchAs(
          actors.admin.accessToken,
          `/payments/${paymentId}/mark-held`,
          receipt,
        ),
      ]);

      const booking = await readBooking(serviceBookingId);
      const payment = await readPayment(paymentId);
      // O dinheiro ou não entrou, ou entrou e a reserva continua viva.
      expect(['CANCELLED:FAILED', 'PENDING:HELD']).toContain(
        `${booking.status}:${payment.status}`,
      );
    });

    it('never starts a service whose payment was refunded', async () => {
      const { serviceBookingId, paymentId } =
        await createHeldServiceBooking(actors);

      const [started, cancelled] = await Promise.all([
        start(serviceBookingId),
        cancelAs(actors.client.accessToken, serviceBookingId),
      ]);

      const booking = await readBooking(serviceBookingId);
      const payment = await readPayment(paymentId);
      // Quem chega segundo é recusado. Se o start ganhou, o cliente já não
      // cancela. Se o cancelamento ganhou, o provider já não começa.
      expect([started.status, cancelled.status].sort()).toEqual([200, 400]);
      expect(['IN_PROGRESS:HELD', 'CANCELLED:REFUNDED']).toContain(
        `${booking.status}:${payment.status}`,
      );
    });
  });

  describe('reviews', () => {
    const review = (serviceBookingId: string) =>
      request(actors.httpServer)
        .post('/api/v1/reviews')
        .set(authHeader(actors.client.accessToken))
        .send({
          serviceBookingId,
          authorRole: 'CLIENT',
          rating: 1,
          comment: 'Cancelou em cima da hora.',
        });

    const canReview = (serviceBookingId: string) =>
      request(actors.httpServer)
        .get(`/api/v1/service-bookings/${serviceBookingId}/can-review`)
        .set(authHeader(actors.client.accessToken));

    it('are refused for a booking cancelled before it was paid', async () => {
      const { serviceBookingId } = await createUnpaidBooking();
      await cancelAs(actors.provider.accessToken, serviceBookingId).expect(200);

      await review(serviceBookingId).expect(400);

      const response = await canReview(serviceBookingId).expect(200);
      expect(response.body.data).toEqual({
        canReview: false,
        reason: 'A reserva não chegou a ser paga.',
      });
      expect(await prisma().review.count()).toBe(0);
    });

    it('are accepted for a booking cancelled after it was paid', async () => {
      const { serviceBookingId } = await createHeldServiceBooking(actors);
      await cancelAs(actors.provider.accessToken, serviceBookingId).expect(200);

      await review(serviceBookingId).expect(201);

      expect(await prisma().review.count()).toBe(1);
    });
  });
});
