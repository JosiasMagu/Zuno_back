import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BookingsService } from '../src/modules/bookings/services/bookings.service';
import { ReconciliationService } from '../src/modules/payments/services/reconciliation.service';
import { ProviderOperationsService } from '../src/modules/payments/services/provider-operations.service';
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
import { acceptServiceQuote, createServiceQuote } from './helpers/service-flow';

// Aluguer de 3 dias a 1500 MZN, com depósito de 5000 e taxa de 450.
const TOTAL = 9950;
const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef';

// O simulador decide pelo fim do número: 00 confirma, 01 recusa, 03 não
// responde e a consulta confirma, 04 fica à espera, 05 confirma 1 MZN a
// menos, 08 confirma com uma taxa de 12,50.
const PHONE = (ending: string) => `+2588412345${ending}`;

describe('Payment collection on the phone E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let operations: ProviderOperationsService;
  let bookings: BookingsService;
  const prisma = () => getTestPrisma();
  const previousEnv = {
    provider: process.env.PAYMENTS_PROVIDER,
    secret: process.env.PAYMENTS_WEBHOOK_SECRET,
  };

  beforeAll(async () => {
    process.env.PAYMENTS_PROVIDER = 'simulator';
    process.env.PAYMENTS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await createTestApp();
    operations = app.get(ProviderOperationsService);
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
    process.env.PAYMENTS_PROVIDER = previousEnv.provider;
    process.env.PAYMENTS_WEBHOOK_SECRET = previousEnv.secret;
    if (previousEnv.provider === undefined)
      delete process.env.PAYMENTS_PROVIDER;
    if (previousEnv.secret === undefined) {
      delete process.env.PAYMENTS_WEBHOOK_SECRET;
    }
  });

  async function createPendingPayment() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);
    return { bookingId, paymentId };
  }

  function collect(
    paymentId: string,
    msisdn: string,
    options: { token?: string; key?: string | null } = {},
  ) {
    const call = request(actors.httpServer)
      .post(`/api/v1/payments/${paymentId}/collect`)
      .set(authHeader(options.token ?? actors.client.accessToken));
    const key = options.key === undefined ? randomUUID() : options.key;
    if (key) {
      call.set('Idempotency-Key', key);
    }
    return call.send({ msisdn });
  }

  function sendEvent(
    body: Record<string, unknown>,
    options: { token?: string | null; provider?: string } = {},
  ) {
    const call = request(actors.httpServer).post(
      `/api/v1/payments/providers/${options.provider ?? 'simulator'}/events`,
    );
    const token = options.token === undefined ? WEBHOOK_SECRET : options.token;
    if (token) {
      call.set('x-zuno-webhook-token', token);
    }
    return call.send(body);
  }

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const readCollections = (paymentId: string) =>
    prisma().providerOperation.findMany({
      where: { paymentId, kind: 'COLLECTION' },
      orderBy: { createdAt: 'asc' },
    });

  const unallocatedOf = (paymentId: string | null) =>
    prisma().unallocatedFunds.findMany({ where: { paymentId } });

  /** O job pergunta pelas operações sem resposta, como daqui a dez minutos. */
  const pollLater = () =>
    operations.pollDue(new Date(Date.now() + 10 * 60_000));

  const totals = async () =>
    (await app.get(ReconciliationService).run()).totals;

  describe('instructions', () => {
    it('tells the app that it can charge the phone', async () => {
      const response = await request(actors.httpServer)
        .get('/api/v1/payments/instructions')
        .set(authHeader(actors.client.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        mode: 'automatic',
        provider: 'simulator',
        receiver: null,
      });
    });
  });

  describe('asking for the money', () => {
    it('holds the money once the client confirms on the phone', async () => {
      const { bookingId, paymentId } = await createPendingPayment();

      const response = await collect(paymentId, PHONE('00')).expect(201);

      expect(response.body.data).toMatchObject({
        status: 'CONFIRMED',
        inProgress: false,
        amount: TOTAL,
        msisdn: PHONE('00'),
      });
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('HELD');
      expect(payment.heldById).toBe('system');
      expect(payment.payerMsisdn).toBe(PHONE('00'));
      expect(await readInflows(paymentId)).toHaveLength(1);
      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.expiresAt).toBeNull();
    });

    it('shows the charge on the payment', async () => {
      const { paymentId } = await createPendingPayment();
      await collect(paymentId, PHONE('00')).expect(201);

      const response = await request(actors.httpServer)
        .get(`/api/v1/payments/${paymentId}`)
        .set(authHeader(actors.client.accessToken))
        .expect(200);

      expect(response.body.data.collection).toMatchObject({
        status: 'CONFIRMED',
        provider: 'simulator',
      });
    });

    it('needs an Idempotency-Key', async () => {
      const { paymentId } = await createPendingPayment();

      await collect(paymentId, PHONE('00'), { key: null }).expect(400);

      expect(await readCollections(paymentId)).toEqual([]);
    });

    it('answers a retry with the same key without charging twice', async () => {
      const { paymentId } = await createPendingPayment();
      const key = randomUUID();

      const first = await collect(paymentId, PHONE('00'), { key });
      const second = await collect(paymentId, PHONE('00'), { key });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await readCollections(paymentId)).toHaveLength(1);
    });

    it('is only for the client who booked', async () => {
      const { paymentId } = await createPendingPayment();

      await collect(paymentId, PHONE('00'), {
        token: actors.provider.accessToken,
      }).expect(403);

      expect(await readCollections(paymentId)).toEqual([]);
    });

    it('works the same for a service booking', async () => {
      const { quoteId } = await createServiceQuote(actors);
      const { paymentId } = await acceptServiceQuote(actors, quoteId);

      await collect(paymentId, PHONE('00')).expect(201);

      expect((await readPayment(paymentId)).status).toBe('HELD');
    });
  });

  describe('when the charge does not go through at once', () => {
    it('leaves the payment waiting after a refusal, and the client can try again', async () => {
      const { paymentId } = await createPendingPayment();

      const refused = await collect(paymentId, PHONE('01')).expect(201);

      expect(refused.body.data).toMatchObject({
        status: 'FAILED',
        failureCode: 'CUSTOMER_REJECTED',
      });
      expect((await readPayment(paymentId)).status).toBe('PENDING');
      const audits = await prisma().auditLog.findMany({
        where: { targetId: paymentId, action: 'PAYMENT_COLLECTION_FAILED' },
      });
      expect(audits).toHaveLength(1);

      await collect(paymentId, PHONE('00')).expect(201);

      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect(
        (await readCollections(paymentId)).map(({ status }) => status),
      ).toEqual(['FAILED', 'CONFIRMED']);
    });

    it('never repeats a charge without an answer: the job asks the provider', async () => {
      const { paymentId } = await createPendingPayment();

      const unknown = await collect(paymentId, PHONE('03')).expect(201);
      expect(unknown.body.data).toMatchObject({
        status: 'UNKNOWN',
        inProgress: true,
      });

      const again = await collect(paymentId, PHONE('00'));
      expect(again.status).toBe(409);
      expect(again.body.errorCode).toBe('PAYMENT_COLLECTION_IN_PROGRESS');

      await pollLater();

      expect((await readPayment(paymentId)).status).toBe('HELD');
      const [operation] = await readCollections(paymentId);
      expect(operation.status).toBe('CONFIRMED');
      expect(operation.checks).toBe(1);
    });

    it('closes a charge waiting on the phone when the provider says so', async () => {
      const { paymentId } = await createPendingPayment();
      await collect(paymentId, PHONE('04')).expect(201);
      const [operation] = await readCollections(paymentId);
      expect(operation.status).toBe('PENDING');

      const notice = {
        eventId: 'evt-0001',
        reference: operation.reference,
        status: 'CONFIRMED',
        providerReference: operation.providerReference,
        amount: TOTAL,
        msisdn: PHONE('04'),
      };
      const first = await sendEvent(notice).expect(200);
      const repeated = await sendEvent(notice).expect(200);

      expect(first.body.data).toEqual({ duplicate: false });
      expect(repeated.body.data).toEqual({ duplicate: true });
      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect(await readInflows(paymentId)).toHaveLength(1);
    });
  });

  describe('provider notices', () => {
    const notice = {
      eventId: 'evt-0002',
      reference: 'ZC00000000000000',
      status: 'FAILED',
    };

    it.each([
      ['a wrong secret', 'segredo-errado'],
      ['no secret', null],
    ])('refuses a notice with %s', async (_case, token) => {
      await sendEvent(notice, { token }).expect(401);

      expect(await prisma().providerEvent.count()).toBe(0);
    });

    it('answers 404 for a provider that is not connected', async () => {
      await sendEvent(notice, { provider: 'mpesa' }).expect(404);
    });

    it('answers 400 to a notice it cannot read', async () => {
      await sendEvent({ status: 'CONFIRMED' }).expect(400);

      expect(await prisma().providerEvent.count()).toBe(0);
    });
  });

  describe('money that does not close the payment', () => {
    it('keeps aside money short of the total, without holding anything', async () => {
      const { paymentId } = await createPendingPayment();

      await collect(paymentId, PHONE('05')).expect(201);

      expect((await readPayment(paymentId)).status).toBe('PENDING');
      expect(await readInflows(paymentId)).toEqual([]);
      const [aside] = await unallocatedOf(paymentId);
      expect(aside).toMatchObject({
        reason: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        payerMsisdn: PHONE('05'),
      });
      expect(Number(aside.amount)).toBe(TOTAL - 1);
      expect(await totals()).toMatchObject({
        unallocatedInAccount: TOTAL - 1,
        expectedInAccount: TOTAL - 1,
      });
    });

    it('keeps aside money that arrives after the booking expired', async () => {
      const { bookingId, paymentId } = await createPendingPayment();
      await collect(paymentId, PHONE('04')).expect(201);
      const [operation] = await readCollections(paymentId);
      await prisma().booking.update({
        where: { id: bookingId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await bookings.expireUnpaidBookings();

      await sendEvent({
        eventId: 'evt-0003',
        reference: operation.reference,
        status: 'CONFIRMED',
        providerReference: operation.providerReference,
        amount: TOTAL,
        msisdn: PHONE('04'),
      }).expect(200);

      expect((await readPayment(paymentId)).status).toBe('FAILED');
      expect(await readInflows(paymentId)).toEqual([]);
      const [aside] = await unallocatedOf(paymentId);
      expect(aside.reason).toBe('LATE');
      expect(Number(aside.amount)).toBe(TOTAL);
    });

    it('keeps aside money with a reference nobody knows', async () => {
      await sendEvent({
        eventId: 'evt-0004',
        reference: 'ZC00000000000000',
        status: 'CONFIRMED',
        providerReference: 'SIMNOBODY0001',
        amount: 300,
        msisdn: PHONE('00'),
      }).expect(200);

      const [aside] = await unallocatedOf(null);
      expect(aside).toMatchObject({
        reason: 'UNKNOWN_REFERENCE',
        providerReference: 'SIMNOBODY0001',
      });
      expect(Number(aside.amount)).toBe(300);
    });

    it('does not count twice a transfer the admin already confirmed from the statement', async () => {
      const { paymentId } = await createPendingPayment();
      await collect(paymentId, PHONE('04')).expect(201);
      const [operation] = await readCollections(paymentId);
      const providerReference = operation.providerReference as string;

      await request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/mark-held`)
        .set(authHeader(actors.admin.accessToken))
        .send({
          mpesaReference: providerReference,
          receivedAmount: TOTAL,
          payerMsisdn: PHONE('04'),
        })
        .expect(200);
      await sendEvent({
        eventId: 'evt-0005',
        reference: operation.reference,
        status: 'CONFIRMED',
        providerReference,
        amount: TOTAL,
        msisdn: PHONE('04'),
      }).expect(200);

      expect(await readInflows(paymentId)).toHaveLength(1);
      expect(await prisma().unallocatedFunds.count()).toBe(0);
      expect(await totals()).toMatchObject({
        received: TOTAL,
        unallocatedInAccount: 0,
      });
    });
  });

  describe('provider fees', () => {
    it('records the fee and takes it from what should be in the account', async () => {
      const { paymentId } = await createPendingPayment();

      await collect(paymentId, PHONE('08')).expect(201);

      const [operation] = await readCollections(paymentId);
      expect(Number(operation.feeAmount)).toBe(12.5);
      expect(await totals()).toMatchObject({
        received: TOTAL,
        providerFees: 12.5,
        expectedInAccount: TOTAL - 12.5,
      });
    });
  });
});
