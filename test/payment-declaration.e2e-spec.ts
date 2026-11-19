import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BookingsService } from '../src/modules/bookings/services/bookings.service';
import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  initiatePayment,
  paymentReceipt,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readInflows } from './helpers/escrow-state';
import { acceptServiceQuote, createServiceQuote } from './helpers/service-flow';
import { expectMoneyReconciles } from './helpers/reconciliation';

const HOUR_MS = 60 * 60 * 1000;
const CONFIRMATION_WINDOW_HOURS = 48;

const PAYER = '+258840000902';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Declaration {
  mpesaReference?: string;
  payerMsisdn?: string;
}

const hoursFromNow = (date: Date | null) =>
  date ? (date.getTime() - Date.now()) / HOUR_MS : null;

// Enquanto o M-Pesa for confirmado à mão, o cliente não controla quando o
// admin confirma. Declarar o pagamento pára o prazo de pagamento e abre uma
// janela para o admin o encontrar no extracto.
describe('Payment declaration E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let bookings: BookingsService;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    bookings = app.get(BookingsService);
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

  function declaration(overrides: Declaration = {}): Declaration {
    return { mpesaReference: 'CHK7H3ABCD', payerMsisdn: PAYER, ...overrides };
  }

  function declareAs(token: string, paymentId: string, body = declaration()) {
    return request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/declare`)
      .set(authHeader(token))
      .send(body);
  }

  const declare = (paymentId: string, body?: Declaration) =>
    declareAs(actors.client.accessToken, paymentId, body);

  const markHeld = async (paymentId: string) =>
    request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(actors.admin.accessToken))
      .send(await paymentReceipt(paymentId));

  const queueAs = (token: string) =>
    request(actors.httpServer)
      .get('/api/v1/payments/admin/declared')
      .set(authHeader(token));

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const readBooking = (bookingId: string) =>
    prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });

  const readServiceBooking = (serviceBookingId: string) =>
    prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });

  /** Reserva confirmada, com o pagamento iniciado e ainda por entrar. */
  async function createUnpaidBooking() {
    const equipmentId = await createApprovedEquipment(actors, { quantity: 3 });
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);

    return { equipmentId, bookingId, paymentId };
  }

  describe('what the client declares', () => {
    it('is stored in one format and moves no money', async () => {
      const { paymentId } = await createUnpaidBooking();

      const response = await declare(
        paymentId,
        declaration({
          mpesaReference: '  chk7h3abcd ',
          payerMsisdn: '84 000 0902',
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('PENDING');
      expect(response.body.data.declaredReference).toBe('CHK7H3ABCD');

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('PENDING');
      expect(payment.declaredReference).toBe('CHK7H3ABCD');
      expect(payment.declaredPayerMsisdn).toBe(PAYER);
      expect(payment.declaredAt).not.toBeNull();
      // A referência do extracto só entra com o mark-held do admin.
      expect(payment.mpesaReference).toBeNull();
      expect(await readInflows(paymentId)).toEqual([]);
    });

    it('goes to the audit log under the client', async () => {
      const { paymentId } = await createUnpaidBooking();

      await declare(paymentId).expect(200);

      const audits = await prisma().auditLog.findMany({
        where: { targetId: paymentId, action: 'PAYMENT_DECLARED' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(actors.client.userId);
      expect(audits[0].metadata).toEqual({
        mpesaReference: 'CHK7H3ABCD',
        payerMsisdn: PAYER,
      });
    });

    it.each([
      ['a reference that is too short', { mpesaReference: 'ABC' }],
      ['a reference with odd characters', { mpesaReference: 'CHK 7H3 <b>' }],
      ['no reference', { mpesaReference: undefined }],
      ['a number that is not Mozambican', { payerMsisdn: '+351912345678' }],
      ['no number', { payerMsisdn: undefined }],
    ])('is refused with %s', async (_label, overrides) => {
      const { paymentId } = await createUnpaidBooking();

      const response = await declare(paymentId, declaration(overrides));

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).declaredAt).toBeNull();
    });
  });

  describe('the deadline', () => {
    it('becomes 48 hours for the admin to confirm, and the answer says so', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();

      const response = await declare(paymentId).expect(200);

      const booking = await readBooking(bookingId);
      const hoursLeft = hoursFromNow(booking.expiresAt);
      expect(hoursLeft).toBeGreaterThan(CONFIRMATION_WINDOW_HOURS - 0.1);
      expect(hoursLeft).toBeLessThanOrEqual(CONFIRMATION_WINDOW_HOURS);
      expect(response.body.data.confirmBy).toBe(
        booking.expiresAt?.toISOString(),
      );
    });

    it('stops a booking about to expire from expiring', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      // Faltam dez minutos para o prazo de pagamento.
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: new Date(Date.now() + HOUR_MS / 6) },
      });

      await declare(paymentId).expect(200);
      const expired = await bookings.expireUnpaidBookings();

      expect(expired).toBe(0);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
      expect(
        hoursFromNow((await readBooking(bookingId)).expiresAt),
      ).toBeGreaterThan(CONFIRMATION_WINDOW_HOURS - 0.1);
    });

    it('is not stretched by declaring again, and the correction is kept', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      await declare(paymentId).expect(200);
      const first = await readPayment(paymentId);
      // Passaram 40 horas da janela de confirmação.
      const eightHoursLeft = new Date(Date.now() + 8 * HOUR_MS);
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: eightHoursLeft },
      });

      await declare(
        paymentId,
        declaration({ mpesaReference: 'CHK9Z9WXYZ' }),
      ).expect(200);

      const payment = await readPayment(paymentId);
      expect(payment.declaredReference).toBe('CHK9Z9WXYZ');
      expect(payment.declaredAt).toEqual(first.declaredAt);
      expect((await readBooking(bookingId)).expiresAt).toEqual(eightHoursLeft);
    });

    it('still expires the booking when the admin does not confirm in time', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      await declare(paymentId).expect(200);
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: new Date(Date.now() - HOUR_MS) },
      });

      const expired = await bookings.expireUnpaidBookings();

      expect(expired).toBe(1);
      expect((await readBooking(bookingId)).status).toBe('EXPIRED');
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('FAILED');
      // O que o cliente declarou fica guardado, para se poder reconciliar.
      expect(payment.declaredReference).toBe('CHK7H3ABCD');
    });
  });

  describe('who may declare', () => {
    it('refuses the provider who is going to be paid', async () => {
      const { paymentId } = await createUnpaidBooking();

      const response = await declareAs(actors.provider.accessToken, paymentId);

      expect(response.status).toBe(403);
      expect((await readPayment(paymentId)).declaredAt).toBeNull();
    });

    it('refuses the admin, who confirms and does not declare', async () => {
      const { paymentId } = await createUnpaidBooking();

      await declareAs(actors.admin.accessToken, paymentId).expect(403);
    });

    it('refuses another client', async () => {
      const { paymentId } = await createUnpaidBooking();
      const outsider = await loginAsOutsider(app);

      await declareAs(outsider.accessToken, paymentId).expect(403);
    });

    it('refuses a request without a session', async () => {
      const { paymentId } = await createUnpaidBooking();

      await request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/declare`)
        .send(declaration())
        .expect(401);
    });

    it('answers 404 for a payment that does not exist', async () => {
      await declare(UNKNOWN_ID).expect(404);
    });
  });

  describe('when it is too late to declare', () => {
    it('refuses a payment the admin already confirmed', async () => {
      const { paymentId } = await createUnpaidBooking();
      expect((await markHeld(paymentId)).status).toBe(200);

      const response = await declare(paymentId);

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).declaredAt).toBeNull();
    });

    it('refuses a booking that already expired', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: new Date(Date.now() - HOUR_MS) },
      });
      await bookings.expireUnpaidBookings();

      const response = await declare(paymentId);

      expect(response.status).toBe(400);
      expect((await readBooking(bookingId)).status).toBe('EXPIRED');
    });
  });

  describe('the admin queue', () => {
    it('lists declared payments oldest first, with what to look for on the statement', async () => {
      const first = await createUnpaidBooking();
      const secondBookingId = await createBooking(actors, first.equipmentId, 5);
      await confirmBooking(actors, secondBookingId);
      const secondPaymentId = await initiatePayment(actors, secondBookingId);
      await declare(
        secondPaymentId,
        declaration({ mpesaReference: 'SECOND0001' }),
      ).expect(200);
      await declare(first.paymentId).expect(200);
      // O segundo pagamento foi declarado uma hora antes do primeiro.
      await prisma().payment.update({
        where: { id: secondPaymentId },
        data: { declaredAt: new Date(Date.now() - HOUR_MS) },
      });

      const response = await queueAs(actors.admin.accessToken);

      expect(response.status).toBe(200);
      const queue = response.body.data as Array<Record<string, unknown>>;
      expect(queue.map((item) => item.id)).toEqual([
        secondPaymentId,
        first.paymentId,
      ]);
      expect(response.body.meta.total).toBe(2);

      const booking = await readBooking(first.bookingId);
      expect(queue[1]).toMatchObject({
        id: first.paymentId,
        totalCharged: 9950,
        declaredReference: 'CHK7H3ABCD',
        declaredPayerMsisdn: PAYER,
        confirmBy: booking.expiresAt?.toISOString(),
        bookingId: first.bookingId,
        serviceBookingId: null,
        client: {
          id: actors.client.userId,
          name: 'Client E2E',
          phone: PAYER,
        },
      });
    });

    it('leaves out payments nobody declared', async () => {
      await createUnpaidBooking();

      const response = await queueAs(actors.admin.accessToken).expect(200);

      expect(response.body.data).toEqual([]);
    });

    it.each([
      ['the client', () => actors.client.accessToken],
      ['the provider', () => actors.provider.accessToken],
    ])('is closed to %s', async (_label, token) => {
      await queueAs(token()).expect(403);
    });
  });

  describe('when the admin confirms a declared payment', () => {
    it('holds it, ends the deadline and takes it off the queue', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();
      await declare(paymentId).expect(200);

      const response = await markHeld(paymentId);

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect((await readBooking(bookingId)).expiresAt).toBeNull();
      const queue = await queueAs(actors.admin.accessToken).expect(200);
      expect(queue.body.data).toEqual([]);
    });

    it('keeps the declared reference next to the one on the statement', async () => {
      const { paymentId } = await createUnpaidBooking();
      await declare(paymentId).expect(200);

      expect((await markHeld(paymentId)).status).toBe(200);

      const audits = await prisma().auditLog.findMany({
        where: { targetId: paymentId, action: 'PAYMENT_MARKED_HELD' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({
        declaredReference: 'CHK7H3ABCD',
      });
    });
  });

  describe('a service booking', () => {
    async function createUnpaidServiceBooking() {
      const { quoteId } = await createServiceQuote(actors);
      return acceptServiceQuote(actors, quoteId);
    }

    it('gets the same 48 hours and shows up on the queue', async () => {
      const { serviceBookingId, paymentId } =
        await createUnpaidServiceBooking();

      await declare(paymentId).expect(200);

      const serviceBooking = await readServiceBooking(serviceBookingId);
      const hoursLeft = hoursFromNow(serviceBooking.expiresAt);
      expect(hoursLeft).toBeGreaterThan(CONFIRMATION_WINDOW_HOURS - 0.1);
      expect(hoursLeft).toBeLessThanOrEqual(CONFIRMATION_WINDOW_HOURS);

      const queue = await queueAs(actors.admin.accessToken).expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0]).toMatchObject({
        id: paymentId,
        bookingId: null,
        serviceBookingId,
        confirmBy: serviceBooking.expiresAt?.toISOString(),
      });
    });

    it('loses the deadline once the admin confirms the payment', async () => {
      const { serviceBookingId, paymentId } =
        await createUnpaidServiceBooking();
      await declare(paymentId).expect(200);

      const response = await markHeld(paymentId);

      expect(response.status).toBe(200);
      expect((await readServiceBooking(serviceBookingId)).expiresAt).toBeNull();
    });

    it('refuses the provider of the service', async () => {
      const { paymentId } = await createUnpaidServiceBooking();

      await declareAs(actors.provider.accessToken, paymentId).expect(403);
    });
  });
});
