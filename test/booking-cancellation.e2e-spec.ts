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
  createHeldBooking,
  initiatePayment,
  isListedAsFree,
  openPaymentDispute,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Reserva de 3 dias a 1500 MZN por dia, com 5000 de depósito.
const RENTAL = 4500;
const TOTAL_CHARGED = 9950;

// Dias até ao início da reserva, de um lado e do outro da janela de 48 horas
// em que o cancelamento do cliente deixa de ser gratuito.
const OUTSIDE_FREE_WINDOW = 5;
const INSIDE_FREE_WINDOW = 1;

describe('Booking cancellation E2E', () => {
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

  function cancelAs(token: string, bookingId: string, reason?: string) {
    return request(actors.httpServer)
      .patch(`/api/v1/bookings/${bookingId}/cancel`)
      .set(authHeader(token))
      .send(reason ? { reason } : {});
  }

  function readEquipment(equipmentId: string) {
    return prisma().equipment.findUniqueOrThrow({
      where: { id: equipmentId },
      select: { isAvailable: true },
    });
  }

  function readPayment(paymentId: string) {
    return prisma().payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        status: true,
        refundAmount: true,
        ownerPayout: true,
        depositStatus: true,
      },
    });
  }

  describe('before the payment is held', () => {
    it('cancels a pending booking and stores the reason', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        OUTSIDE_FREE_WINDOW,
      );

      const response = await cancelAs(
        actors.client.accessToken,
        bookingId,
        '  Já não preciso do equipamento.  ',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('CANCELLED');

      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.status).toBe('CANCELLED');
      expect(booking.cancelledAt).not.toBeNull();
      expect(booking.cancellationReason).toBe('Já não preciso do equipamento.');
      expect(
        await isListedAsFree(actors, equipmentId, OUTSIDE_FREE_WINDOW),
      ).toBe(true);
    });

    it('frees the dates and fails the payment of a confirmed booking', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        OUTSIDE_FREE_WINDOW,
      );
      await confirmBooking(actors, bookingId);
      const paymentId = await initiatePayment(actors, bookingId);
      expect(
        await isListedAsFree(actors, equipmentId, OUTSIDE_FREE_WINDOW),
      ).toBe(false);

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect(
        await isListedAsFree(actors, equipmentId, OUTSIDE_FREE_WINDOW),
      ).toBe(true);
      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await readOutflows(paymentId)).toEqual([]);
      expect(await readPayouts(paymentId)).toEqual([]);
    });
  });

  describe('with the payment held in escrow', () => {
    it('refunds the client in full outside the 48-hour window', async () => {
      const { equipmentId, bookingId, paymentId } = await createHeldBooking(
        actors,
        { startsInDays: OUTSIDE_FREE_WINDOW },
      );

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('REFUNDED');
      expect(Number(payment.refundAmount)).toBe(TOTAL_CHARGED);
      expect(Number(payment.ownerPayout)).toBe(0);
      expect(payment.depositStatus).toBe('RETURNED');
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${TOTAL_CHARGED}:PENDING`,
      ]);
      expect(
        await isListedAsFree(actors, equipmentId, OUTSIDE_FREE_WINDOW),
      ).toBe(true);
      expect(await prisma().providerStrike.count()).toBe(0);
    });

    it('retains 30% of the rental when the client cancels inside the window', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: INSIDE_FREE_WINDOW,
      });
      const retained = RENTAL * 0.3;
      const platformCut = retained * 0.1;
      const providerCompensation = retained - platformCut;
      const clientRefund = TOTAL_CHARGED - retained;

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('PARTIALLY_REFUNDED');
      expect(Number(payment.refundAmount)).toBe(clientRefund);
      expect(Number(payment.ownerPayout)).toBe(providerCompensation);
      expect(payment.depositStatus).toBe('RETURNED');
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${clientRefund}`,
        `PLATFORM:${platformCut}`,
        `PROVIDER:${providerCompensation}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${clientRefund}:PENDING`,
        `PROVIDER_PAYOUT:${providerCompensation}:PENDING`,
      ]);

      const audit = await prisma().auditLog.findFirstOrThrow({
        where: { action: 'BOOKING_CANCELLED', targetId: bookingId },
      });
      expect(audit.actorId).toBe(actors.client.userId);
      expect(Number(audit.amount)).toBe(clientRefund);
      expect(audit.metadata).toEqual({
        reason: null,
        cancelledBy: 'CLIENT',
        paymentOutcome: 'REFUNDED_WITH_RETENTION',
        providerCompensation,
        platformCut,
      });
    });

    it('refunds the client in full and gives the provider a strike when the provider cancels', async () => {
      const { equipmentId, bookingId, paymentId } = await createHeldBooking(
        actors,
        { startsInDays: INSIDE_FREE_WINDOW },
      );

      const response = await cancelAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('REFUNDED');
      expect(Number(payment.refundAmount)).toBe(TOTAL_CHARGED);
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(
        await isListedAsFree(actors, equipmentId, INSIDE_FREE_WINDOW),
      ).toBe(true);

      const strikes = await prisma().providerStrike.findMany();
      expect(strikes).toHaveLength(1);
      expect(strikes[0]).toMatchObject({
        userId: actors.provider.userId,
        bookingId,
      });
      const strikeAudits = await prisma().auditLog.count({
        where: {
          action: 'PROVIDER_STRIKE_ISSUED',
          targetId: actors.provider.userId,
        },
      });
      expect(strikeAudits).toBe(1);
    });

    it('refunds the client in full without a strike when an admin cancels', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: INSIDE_FREE_WINDOW,
      });

      const response = await cancelAs(actors.admin.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(await prisma().providerStrike.count()).toBe(0);
    });
  });

  describe('after the rental has started', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Faz de conta que o aluguer começou ontem. */
    async function startRentalYesterday(bookingId: string) {
      await prisma().booking.update({
        where: { id: bookingId },
        data: {
          startDate: new Date(Date.now() - DAY_MS),
          endDate: new Date(Date.now() + 2 * DAY_MS),
        },
      });
    }

    async function createStartedHeldBooking() {
      const held = await createHeldBooking(actors, {
        startsInDays: INSIDE_FREE_WINDOW,
      });
      await startRentalYesterday(held.bookingId);
      return held;
    }

    it('returns 400 to the client and leaves the money in escrow', async () => {
      const { bookingId, paymentId } = await createStartedHeldBooking();

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('BOOKING_RENTAL_STARTED');
      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.status).toBe('CONFIRMED');
      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect(await readOutflows(paymentId)).toEqual([]);
      expect(await readPayouts(paymentId)).toEqual([]);
    });

    it('leaves the dispute open to the client', async () => {
      const { bookingId, paymentId } = await createStartedHeldBooking();
      await cancelAs(actors.client.accessToken, bookingId).expect(400);

      const disputeId = await openPaymentDispute(actors, {
        bookingId,
        paymentId,
      });

      expect(disputeId).toEqual(expect.any(String));
    });

    it('lets the client close a booking that was never paid', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        INSIDE_FREE_WINDOW,
      );
      await confirmBooking(actors, bookingId);
      const paymentId = await initiatePayment(actors, bookingId);
      await startRentalYesterday(bookingId);

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await readOutflows(paymentId)).toEqual([]);
    });

    it('lets the provider cancel, with a full refund to the client', async () => {
      const { bookingId, paymentId } = await createStartedHeldBooking();

      const response = await cancelAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
    });
  });

  it('suspends the provider listings on the third strike', async () => {
    const equipmentId = await createApprovedEquipment(actors);

    for (let strike = 1; strike <= 3; strike += 1) {
      const bookingId = await createBooking(
        actors,
        equipmentId,
        OUTSIDE_FREE_WINDOW,
      );
      await confirmBooking(actors, bookingId);
      const response = await cancelAs(actors.provider.accessToken, bookingId);
      expect(response.status).toBe(200);

      const provider = await prisma().user.findUniqueOrThrow({
        where: { id: actors.provider.userId },
        select: { listingsSuspendedUntil: true },
      });
      const { isAvailable } = await readEquipment(equipmentId);

      if (strike < 3) {
        expect(provider.listingsSuspendedUntil).toBeNull();
        expect(isAvailable).toBe(true);
      } else {
        expect(provider.listingsSuspendedUntil).not.toBeNull();
        expect(isAvailable).toBe(false);
      }
    }
  });

  describe('while the provider listings are suspended', () => {
    async function suspendProvider() {
      const equipmentId = await createApprovedEquipment(actors);
      await prisma().user.update({
        where: { id: actors.provider.userId },
        data: { listingsSuspendedUntil: new Date(Date.now() + 86_400_000) },
      });
      await prisma().equipment.update({
        where: { id: equipmentId },
        data: { isAvailable: false },
      });

      return equipmentId;
    }

    function toggleAs(token: string, equipmentId: string) {
      return request(actors.httpServer)
        .patch(`/api/v1/equipment/${equipmentId}/toggle-availability`)
        .set(authHeader(token))
        .send({});
    }

    it('refuses new bookings for the suspended equipment', async () => {
      const equipmentId = await suspendProvider();

      const response = await request(actors.httpServer)
        .post('/api/v1/bookings')
        .set(authHeader(actors.client.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({
          equipmentId,
          startDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          endDate: new Date(Date.now() + 8 * 86_400_000).toISOString(),
        });

      expect(response.status).toBe(400);
    });

    it('returns 403 when the provider tries to reopen the equipment', async () => {
      const equipmentId = await suspendProvider();

      const response = await toggleAs(actors.provider.accessToken, equipmentId);

      expect(response.status).toBe(403);
      expect((await readEquipment(equipmentId)).isAvailable).toBe(false);
    });

    it('lets an admin reopen it', async () => {
      const equipmentId = await suspendProvider();

      const response = await toggleAs(actors.admin.accessToken, equipmentId);

      expect(response.status).toBe(200);
      expect((await readEquipment(equipmentId)).isAvailable).toBe(true);
    });
  });

  describe('refusals', () => {
    it('returns 403 to a user who is not a party to the booking', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        OUTSIDE_FREE_WINDOW,
      );
      const outsider = await loginAsOutsider(app);

      const response = await cancelAs(outsider.accessToken, bookingId);

      expect(response.status).toBe(403);
    });

    it('returns 400 once the client has confirmed the delivery', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: INSIDE_FREE_WINDOW,
      });
      await request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/release`)
        .set(authHeader(actors.client.accessToken))
        .send({})
        .expect(200);

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(400);
    });

    it('returns 400 when the booking is already cancelled', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        OUTSIDE_FREE_WINDOW,
      );
      await cancelAs(actors.client.accessToken, bookingId).expect(200);

      const response = await cancelAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(400);
    });

    it('returns 404 for an unknown booking', async () => {
      const response = await cancelAs(actors.client.accessToken, randomUUID());

      expect(response.status).toBe(404);
    });
  });
});
