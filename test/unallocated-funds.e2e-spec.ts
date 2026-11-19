import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ReconciliationService } from '../src/modules/payments/services/reconciliation.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  initiatePayment,
  paymentReceipt,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Aluguer de 3 dias a 1500 MZN, com depósito de 5000 e taxa de 450.
const TOTAL = 9950;
const PAYER = '+258841234567';
const RECEIVER = { number: '+258840000999', name: 'ZUNO Pagamentos' };

// O modo manual: o cliente paga para o número da plataforma e o admin
// confirma pelo extracto. É o modo de hoje, antes do M-Pesa.
describe('Unallocated funds (manual mode) E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();
  const settings = {
    PAYMENTS_PROVIDER: 'manual',
    PAYMENTS_MANUAL_RECEIVER_NUMBER: RECEIVER.number,
    PAYMENTS_MANUAL_RECEIVER_NAME: RECEIVER.name,
  };
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(settings)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
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
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function createPendingPayment() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);
    return { bookingId, paymentId };
  }

  const admin = () => authHeader(actors.admin.accessToken);

  const register = (body: Record<string, unknown>, token = admin()) =>
    request(actors.httpServer)
      .post('/api/v1/payments/admin/unallocated')
      .set(token)
      .send(body);

  const markReturned = (id: string, returnReference: string) =>
    request(actors.httpServer)
      .patch(`/api/v1/payments/admin/unallocated/${id}/returned`)
      .set(admin())
      .send({ returnReference });

  const markHeld = (paymentId: string, body: Record<string, unknown>) =>
    request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(admin())
      .send(body);

  const totals = async () =>
    (await app.get(ReconciliationService).run()).totals;

  describe('how the client pays', () => {
    it('tells the app to pay to the platform number and declare it', async () => {
      const response = await request(actors.httpServer)
        .get('/api/v1/payments/instructions')
        .set(authHeader(actors.client.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        mode: 'manual',
        provider: 'manual',
        receiver: RECEIVER,
      });
    });

    it('refuses to charge the phone, saying how to pay instead', async () => {
      const { paymentId } = await createPendingPayment();

      const response = await request(actors.httpServer)
        .post(`/api/v1/payments/${paymentId}/collect`)
        .set(authHeader(actors.client.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ msisdn: PAYER });

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('PAYMENT_COLLECTION_UNAVAILABLE');
    });

    it.each(['manual', 'mpesa'])(
      'answers 404 to a notice for the %s provider',
      async (provider) => {
        await request(actors.httpServer)
          .post(`/api/v1/payments/providers/${provider}/events`)
          .set('x-zuno-webhook-token', 'qualquer-coisa')
          .send({ eventId: 'evt-1', status: 'FAILED' })
          .expect(404);
      },
    );
  });

  describe('money from the statement that closes no payment', () => {
    it('is registered, listed, and counted as in the account but not ours', async () => {
      const { paymentId } = await createPendingPayment();

      const response = await register({
        mpesaReference: 'SHORT00001',
        amount: 9000,
        payerMsisdn: PAYER,
        paymentId,
        note: 'O cliente pagou menos.',
      }).expect(201);

      expect(response.body.data).toMatchObject({
        provider: 'manual',
        providerReference: 'SHORT00001',
        amount: 9000,
        reason: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        paymentId,
      });
      const listed = await request(actors.httpServer)
        .get('/api/v1/payments/admin/unallocated?status=OPEN')
        .set(admin())
        .expect(200);
      expect(listed.body.data).toHaveLength(1);
      expect(await totals()).toMatchObject({
        received: 0,
        unallocatedInAccount: 9000,
        expectedInAccount: 9000,
      });
    });

    it('marks money without a payment as an unknown reference', async () => {
      const response = await register({
        mpesaReference: 'NOBODY0001',
        amount: 300,
        payerMsisdn: PAYER,
      }).expect(201);

      expect(response.body.data.reason).toBe('UNKNOWN_REFERENCE');
    });

    it('answers 404 for a payment that does not exist', async () => {
      await register({
        mpesaReference: 'NOBODY0002',
        amount: 300,
        payerMsisdn: PAYER,
        paymentId: randomUUID(),
      }).expect(404);
    });

    it('counts each transfer once', async () => {
      const { paymentId } = await createPendingPayment();
      const receipt = await paymentReceipt(paymentId);
      await markHeld(paymentId, receipt).expect(200);
      await register({
        mpesaReference: 'TWICE00001',
        amount: 300,
        payerMsisdn: PAYER,
      }).expect(201);

      const sameAsPayment = await register({
        mpesaReference: receipt.mpesaReference,
        amount: 300,
        payerMsisdn: PAYER,
      });
      const sameAsAside = await register({
        mpesaReference: 'TWICE00001',
        amount: 300,
        payerMsisdn: PAYER,
      });
      const other = await createPendingPayment();
      const heldWithAside = await markHeld(other.paymentId, {
        mpesaReference: 'TWICE00001',
        receivedAmount: TOTAL,
        payerMsisdn: PAYER,
      });

      for (const response of [sameAsPayment, sameAsAside, heldWithAside]) {
        expect(response.status).toBe(409);
        expect(response.body.errorCode).toBe('PAYMENT_REFERENCE_ALREADY_USED');
      }
      expect(
        (
          await prisma().payment.findUniqueOrThrow({
            where: { id: other.paymentId },
          })
        ).status,
      ).toBe('PENDING');
    });

    it('is closed to anyone who is not an admin', async () => {
      await register(
        { mpesaReference: 'NOBODY0003', amount: 300, payerMsisdn: PAYER },
        authHeader(actors.client.accessToken),
      ).expect(403);
      await request(actors.httpServer)
        .get('/api/v1/payments/admin/unallocated')
        .set(authHeader(actors.provider.accessToken))
        .expect(403);
    });
  });

  describe('returning it', () => {
    async function registerShort(reference = 'SHORT00002') {
      const response = await register({
        mpesaReference: reference,
        amount: 9000,
        payerMsisdn: PAYER,
      }).expect(201);
      return response.body.data.id as string;
    }

    it('records the return by hand and leaves the account', async () => {
      const id = await registerShort();

      const response = await markReturned(id, 'BACK000001').expect(200);

      expect(response.body.data).toMatchObject({
        status: 'RETURNED',
        returnReference: 'BACK000001',
      });
      expect(await totals()).toMatchObject({
        unallocatedInAccount: 0,
        expectedInAccount: 0,
      });
      const operations = await prisma().providerOperation.findMany({
        where: { unallocatedId: id },
      });
      expect(operations).toEqual([
        expect.objectContaining({
          provider: 'manual',
          kind: 'RETURN',
          status: 'CONFIRMED',
          providerReference: 'BACK000001',
        }),
      ]);
      const audits = await prisma().auditLog.findMany({
        where: { targetId: id, action: 'PAYMENT_UNALLOCATED_RETURNED' },
      });
      expect(audits).toHaveLength(1);
    });

    it('refuses to return the same money twice', async () => {
      const id = await registerShort();
      await markReturned(id, 'BACK000002').expect(200);

      await markReturned(id, 'BACK000003').expect(400);
    });

    it('refuses a return reference that already closed another transfer out', async () => {
      const first = await registerShort('SHORT00003');
      const second = await registerShort('SHORT00004');
      await markReturned(first, 'BACK000004').expect(200);

      const response = await markReturned(second, 'BACK000004');

      expect(response.status).toBe(409);
      expect(
        (
          await prisma().unallocatedFunds.findUniqueOrThrow({
            where: { id: second },
          })
        ).status,
      ).toBe('OPEN');
    });

    it('refuses a return reference already used by a payout', async () => {
      const { paymentId } = await createPendingPayment();
      await markHeld(paymentId, await paymentReceipt(paymentId)).expect(200);
      await releasePayment(actors, paymentId);
      const payout = await prisma().payout.findFirstOrThrow({
        where: { paymentId },
      });
      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payout.id}/execute`)
        .set(admin())
        .send({ mpesaReference: 'OUT0000001' })
        .expect(200);
      const id = await registerShort();

      await markReturned(id, 'OUT0000001').expect(409);
    });

    it('cannot send it back through the provider in manual mode', async () => {
      const id = await registerShort();

      const response = await request(actors.httpServer)
        .post(`/api/v1/payments/admin/unallocated/${id}/return`)
        .set(admin())
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('PAYOUT_TRANSFER_UNAVAILABLE');
    });
  });
});
