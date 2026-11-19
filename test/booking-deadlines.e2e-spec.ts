import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BookingsService } from '../src/modules/bookings/services/bookings.service';
import { PaymentsService } from '../src/modules/payments/services/payments.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  createHeldBooking,
  initiatePayment,
  isListedAsFree,
  openDepositClaim,
  openPaymentDispute,
  paymentReceipt,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STARTS_IN_DAYS = 5;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

/** Meio-dia de um dia daqui a `days` dias, para não depender do fuso. */
function noonInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

// Os jobs estão desligados em NODE_ENV=test. Os testes chamam directamente o
// método que o scheduler chamaria.
describe('Booking deadlines E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let bookings: BookingsService;
  let payments: PaymentsService;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    bookings = app.get(BookingsService);
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

  const readBooking = (bookingId: string) =>
    prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const auditsOf = (targetId: string) =>
    prisma().auditLog.findMany({
      where: { targetId },
      select: { action: true, actorId: true },
    });

  function book(equipmentId: string, from: number, to: number) {
    return request(actors.httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(actors.client.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({
        equipmentId,
        startDate: noonInDays(from),
        endDate: noonInDays(to),
      });
  }

  describe('payment deadline', () => {
    async function letDeadlinePass(bookingId: string) {
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: hoursAgo(1) },
      });
    }

    /** Reserva confirmada, com o pagamento iniciado mas ainda por entrar. */
    async function createUnpaidBooking() {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );
      await confirmBooking(actors, bookingId);
      const paymentId = await initiatePayment(actors, bookingId);

      return { equipmentId, bookingId, paymentId };
    }

    it('gives a new booking 24 hours to be paid, and says so', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await book(equipmentId, 5, 8).expect(201);

      const expiresAt = new Date(response.body.data.expiresAt as string);
      const hoursToPay = (expiresAt.getTime() - Date.now()) / HOUR_MS;
      expect(hoursToPay).toBeGreaterThan(23.9);
      expect(hoursToPay).toBeLessThanOrEqual(24);
    });

    it('starts the payment deadline again when the provider confirms', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );
      // O provider levou quase o prazo todo a responder.
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: new Date(Date.now() + HOUR_MS) },
      });

      await confirmBooking(actors, bookingId);

      const booking = await readBooking(bookingId);
      const hoursToPay =
        ((booking.expiresAt as Date).getTime() - Date.now()) / HOUR_MS;
      expect(hoursToPay).toBeGreaterThan(23.9);
      expect(hoursToPay).toBeLessThanOrEqual(24);
    });

    it('cuts the deadline two hours before the day the rental starts', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await book(equipmentId, 1, 3).expect(201);

      const booking = await readBooking(response.body.data.id as string);
      expect(booking.expiresAt).toEqual(
        new Date(booking.startDate.getTime() - 2 * HOUR_MS),
      );
    });

    it('expires an unpaid booking after the deadline and frees its dates', async () => {
      const { equipmentId, bookingId, paymentId } = await createUnpaidBooking();
      await letDeadlinePass(bookingId);

      const expired = await bookings.expireUnpaidBookings();

      expect(expired).toBe(1);
      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('EXPIRED');
      expect(booking.cancellationReason).toBe(
        'A reserva expirou porque não foi paga dentro do prazo.',
      );
      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        true,
      );
    });

    it('expires a booking the provider never confirmed', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );
      await letDeadlinePass(bookingId);

      await bookings.expireUnpaidBookings();

      expect((await readBooking(bookingId)).status).toBe('EXPIRED');
    });

    it('leaves a booking alone while its deadline has not passed', async () => {
      const { bookingId } = await createUnpaidBooking();

      const expired = await bookings.expireUnpaidBookings();

      expect(expired).toBe(0);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
    });

    it('takes the deadline away once the money is in escrow', async () => {
      const { bookingId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      expect((await readBooking(bookingId)).expiresAt).toBeNull();
    });

    it('never expires a paid booking, even with a deadline in the past', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      await letDeadlinePass(bookingId);

      const expired = await bookings.expireUnpaidBookings();

      expect(expired).toBe(0);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('refuses to hold the payment of an expired booking', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      await letDeadlinePass(bookingId);
      await bookings.expireUnpaidBookings();

      const response = await request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/mark-held`)
        .set(authHeader(actors.admin.accessToken))
        .send(await paymentReceipt(paymentId));

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('FAILED');
    });
  });

  describe('booking length', () => {
    it('accepts a booking of 90 days', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      await book(equipmentId, 5, 95).expect(201);
    });

    it('returns 400 for a booking of 91 days', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await book(equipmentId, 5, 96);

      expect(response.status).toBe(400);
      expect(await prisma().booking.count()).toBe(0);
    });
  });

  describe('automatic release', () => {
    /** Aluguer pago cujo início e cuja entrada do dinheiro ficam onde o teste precisa. */
    async function createHeldRental(when: {
      startedDaysAgo: number;
      heldDaysAgo: number;
    }) {
      const rental = await createHeldBooking(actors, { startsInDays: 1 });
      await prisma().booking.update({
        where: { id: rental.bookingId },
        data: {
          startDate: daysAgo(when.startedDaysAgo),
          endDate: daysAgo(when.startedDaysAgo - 3),
        },
      });
      await prisma().payment.update({
        where: { id: rental.paymentId },
        data: { heldAt: daysAgo(when.heldDaysAgo) },
      });

      return rental;
    }

    it('releases the payment three days after the rental started', async () => {
      const { bookingId, paymentId } = await createHeldRental({
        startedDaysAgo: 4,
        heldDaysAgo: 6,
      });

      const released = await payments.autoReleaseDue();

      expect(released).toBe(1);
      expect((await readPayment(paymentId)).status).toBe('RELEASED');
      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
    });

    it('records the release as done by the system, not by the client', async () => {
      const { paymentId } = await createHeldRental({
        startedDaysAgo: 4,
        heldDaysAgo: 6,
      });

      await payments.autoReleaseDue();

      const audits = await auditsOf(paymentId);
      expect(audits).toContainEqual({
        action: 'PAYMENT_AUTO_RELEASED',
        actorId: 'system',
      });
      expect(audits.map(({ action }) => action)).not.toContain(
        'PAYMENT_RELEASED',
      );
      const outflows = await prisma().ledgerEntry.findMany({
        where: { paymentId, direction: 'OUTFLOW' },
      });
      expect(outflows.length).toBeGreaterThan(0);
      expect(outflows.every(({ actorId }) => actorId === null)).toBe(true);
    });

    it('waits three days from the moment the money entered escrow', async () => {
      const { paymentId } = await createHeldRental({
        startedDaysAgo: 4,
        heldDaysAgo: 1,
      });

      const released = await payments.autoReleaseDue();

      expect(released).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('tells the client a day before releasing it, once', async () => {
      const { paymentId } = await createHeldRental({
        startedDaysAgo: 2.5,
        heldDaysAgo: 2.5,
      });

      expect(await payments.remindAutoReleaseDue()).toBe(1);
      expect(await payments.remindAutoReleaseDue()).toBe(0);

      const payment = await readPayment(paymentId);
      expect(payment.autoReleaseReminderAt).toBeInstanceOf(Date);
      expect(payment.status).toBe('HELD');
    });

    it('does not remind a client whose release is still far away', async () => {
      const { paymentId } = await createHeldRental({
        startedDaysAgo: 1,
        heldDaysAgo: 1,
      });

      expect(await payments.remindAutoReleaseDue()).toBe(0);
      expect((await readPayment(paymentId)).autoReleaseReminderAt).toBeNull();
    });

    it('does not release before three days of rental have passed', async () => {
      const { paymentId } = await createHeldRental({
        startedDaysAgo: 2,
        heldDaysAgo: 6,
      });

      const released = await payments.autoReleaseDue();

      expect(released).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('leaves a disputed payment in escrow', async () => {
      const { bookingId, paymentId } = await createHeldRental({
        startedDaysAgo: 4,
        heldDaysAgo: 6,
      });
      await openPaymentDispute(actors, { bookingId, paymentId });

      const released = await payments.autoReleaseDue();

      expect(released).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });
  });

  describe('deposit claim window', () => {
    /** Aluguer entregue, com o fim e a entrega onde o teste precisa. */
    async function createDeliveredRental(when: {
      endedHoursAgo: number;
      deliveredHoursAgo: number;
    }) {
      const rental = await createHeldBooking(actors, { startsInDays: 1 });
      await releasePayment(actors, rental.paymentId);
      const endDate = hoursAgo(when.endedHoursAgo);
      await prisma().booking.update({
        where: { id: rental.bookingId },
        data: {
          startDate: new Date(endDate.getTime() - 3 * DAY_MS),
          endDate,
          deliveryConfirmedAt: hoursAgo(when.deliveredHoursAgo),
        },
      });

      return rental;
    }

    const LATE_DELIVERY = { endedHoursAgo: 72, deliveredHoursAgo: 2 };
    const WINDOW_CLOSED = { endedHoursAgo: 72, deliveredHoursAgo: 60 };

    it('lets the provider claim within 48 hours of a late delivery', async () => {
      const { bookingId } = await createDeliveredRental(LATE_DELIVERY);

      const disputeId = await openDepositClaim(actors, bookingId);

      expect(disputeId).toEqual(expect.any(String));
    });

    it('returns 400 once 48 hours have passed since the end and the delivery', async () => {
      const { bookingId } = await createDeliveredRental(WINDOW_CLOSED);

      const response = await request(actors.httpServer)
        .post('/api/v1/disputes/deposit-claim')
        .set(authHeader(actors.provider.accessToken))
        .send({
          bookingId,
          description: 'A betoneira foi devolvida com o motor queimado.',
        });

      expect(response.status).toBe(400);
    });

    it('keeps the deposit in escrow while the window is open', async () => {
      const { bookingId, paymentId } =
        await createDeliveredRental(LATE_DELIVERY);

      const returned = await bookings.autoReturnDepositsDue();

      expect(returned).toBe(0);
      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
      expect((await readPayment(paymentId)).depositStatus).toBe('HELD');
    });

    it('returns the deposit by itself once the window has closed', async () => {
      const { bookingId, paymentId } =
        await createDeliveredRental(WINDOW_CLOSED);

      const returned = await bookings.autoReturnDepositsDue();

      expect(returned).toBe(1);
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect((await readPayment(paymentId)).depositStatus).toBe('RETURNED');
    });

    it('records the automatic return as done by the system, not by the provider', async () => {
      const { bookingId } = await createDeliveredRental(WINDOW_CLOSED);

      await bookings.autoReturnDepositsDue();

      const audits = await auditsOf(bookingId);
      expect(audits).toContainEqual({
        action: 'DEPOSIT_AUTO_RETURNED',
        actorId: 'system',
      });
      expect(audits.map(({ action }) => action)).not.toContain(
        'BOOKING_RETURN_CONFIRMED',
      );
    });
  });
});
