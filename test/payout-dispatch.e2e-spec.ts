import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PayoutDispatcher } from '../src/modules/payments/services/payout-dispatcher.service';
import { ProviderOperationsService } from '../src/modules/payments/services/provider-operations.service';
import { createTestApp } from './helpers/app';
import { authHeader, loginViaApi, LoginResult } from './helpers/auth';
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
import { hashTestPassword, TEST_PASSWORD } from './helpers/seed-test-data';

// Aluguer de 3 dias a 1500 MZN: o provider recebe 4050, abaixo do limite de
// 4500, e sai sozinho. Um reembolso do total (9950) fica acima e espera por
// aprovação.
const AUTO_MAX = 4500;
const PROVIDER_PAYOUT = 4050;
const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdef';

// O simulador decide pelo fim do número: 00 envia, 01 recusa, 03 não
// responde e a consulta confirma, 06 não responde nunca.
const PHONE = (ending: string) => `+2588412345${ending}`;
const PAYER = PHONE('44');

describe('Payout dispatch E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let secondAdmin: LoginResult;
  let dispatcher: PayoutDispatcher;
  let operations: ProviderOperationsService;
  const prisma = () => getTestPrisma();
  const settings = {
    PAYMENTS_PROVIDER: 'simulator',
    PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYOUT_AUTO_MAX_AMOUNT: String(AUTO_MAX),
    MONEY_FOUR_EYES: 'true',
  };
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(settings)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    app = await createTestApp();
    dispatcher = app.get(PayoutDispatcher);
    operations = app.get(ProviderOperationsService);
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
    secondAdmin = await loginViaApi(app, '+258840000903', TEST_PASSWORD);
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

  /** O número para onde o provider recebe, lido quando o payout nasce. */
  const setProviderNumber = (msisdn: string) =>
    prisma().user.update({
      where: { id: actors.seed.provider.id },
      data: { payoutMsisdn: msisdn },
    });

  /** Reserva paga, com o pagamento confirmado pelo primeiro admin. */
  async function createHeld() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);
    await request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(actors.admin.accessToken))
      .send({ ...(await paymentReceipt(paymentId)), payerMsisdn: PAYER })
      .expect(200);
    return { bookingId, paymentId };
  }

  /** Payout do provider depois de o cliente confirmar a entrega. */
  async function createProviderPayout(msisdn: string) {
    await setProviderNumber(msisdn);
    const { paymentId } = await createHeld();
    await releasePayment(actors, paymentId);
    return prisma().payout.findFirstOrThrow({
      where: { paymentId, kind: 'PROVIDER_PAYOUT' },
    });
  }

  /** Reembolso do total, acima do valor automático. */
  async function createRefundPayout() {
    const { paymentId } = await createHeld();
    await request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/refund`)
      .set(authHeader(actors.admin.accessToken))
      .send({})
      .expect(200);
    return prisma().payout.findFirstOrThrow({
      where: { paymentId, kind: 'CLIENT_REFUND' },
    });
  }

  const readPayout = (payoutId: string) =>
    prisma().payout.findUniqueOrThrow({ where: { id: payoutId } });

  const operationsOf = (payoutId: string) =>
    prisma().providerOperation.findMany({
      where: { payoutId },
      orderBy: { createdAt: 'asc' },
    });

  const approveAs = (admin: LoginResult, payoutId: string) =>
    request(actors.httpServer)
      .patch(`/api/v1/payouts/${payoutId}/approve`)
      .set(authHeader(admin.accessToken))
      .send({});

  const executeAs = (admin: LoginResult, payoutId: string) =>
    request(actors.httpServer)
      .patch(`/api/v1/payouts/${payoutId}/execute`)
      .set(authHeader(admin.accessToken))
      .send({ mpesaReference: 'QGH7RT51XK' });

  const pollLater = () =>
    operations.pollDue(new Date(Date.now() + 10 * 60_000));

  describe('under the automatic limit', () => {
    it('goes out by itself and is recorded as sent by the system', async () => {
      const payout = await createProviderPayout(PHONE('00'));

      expect(await dispatcher.dispatchDue()).toBe(1);

      const sent = await readPayout(payout.id);
      expect(sent.status).toBe('EXECUTED');
      expect(sent.mpesaReference).toMatch(/^SIM/);
      expect(sent.executedById).toBe('system');
      expect(Number(sent.amount)).toBe(PROVIDER_PAYOUT);
      const [operation] = await operationsOf(payout.id);
      expect(operation).toMatchObject({
        provider: 'simulator',
        kind: 'PAYOUT',
        status: 'CONFIRMED',
        msisdn: PHONE('00'),
      });
      const audits = await prisma().auditLog.findMany({
        where: { targetId: payout.id, action: 'PAYOUT_SENT' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe('system');
    });

    it('is sent once when two sends race for it', async () => {
      const payout = await createProviderPayout(PHONE('00'));

      await Promise.allSettled([
        dispatcher.send(payout.id, 'system'),
        dispatcher.send(payout.id, 'system'),
      ]);

      expect(await operationsOf(payout.id)).toHaveLength(1);
      expect((await readPayout(payout.id)).status).toBe('EXECUTED');
    });
  });

  describe('above the automatic limit', () => {
    it('waits for an admin, and the queue says so', async () => {
      const payout = await createRefundPayout();

      expect(await dispatcher.dispatchDue()).toBe(0);

      expect((await readPayout(payout.id)).status).toBe('PENDING');
      const queue = await request(actors.httpServer)
        .get('/api/v1/payouts?status=PENDING')
        .set(authHeader(secondAdmin.accessToken))
        .expect(200);
      expect(queue.body.data).toEqual([
        expect.objectContaining({
          id: payout.id,
          kind: 'CLIENT_REFUND',
          needsApproval: true,
          approvedAt: null,
        }),
      ]);
    });

    it('goes out once another admin approves it, to the number that paid', async () => {
      const payout = await createRefundPayout();

      const response = await approveAs(secondAdmin, payout.id).expect(200);

      expect(response.body.message).toBe(
        'Payout aprovado e enviado ao fornecedor.',
      );
      const sent = await readPayout(payout.id);
      expect(sent).toMatchObject({
        status: 'EXECUTED',
        msisdn: PAYER,
        approvedById: secondAdmin.userId,
        executedById: secondAdmin.userId,
      });
      const actions = (
        await prisma().auditLog.findMany({
          where: { targetId: payout.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map(({ action }) => action);
      expect(actions).toEqual(['PAYOUT_APPROVED', 'PAYOUT_SENT']);
    });

    it('cannot be approved by the admin who confirmed the money coming in', async () => {
      const payout = await createRefundPayout();

      const response = await approveAs(actors.admin, payout.id);

      expect(response.status).toBe(403);
      expect(response.body.errorCode).toBe('MONEY_CONTROL_VIOLATION');
      const untouched = await readPayout(payout.id);
      expect(untouched.status).toBe('PENDING');
      expect(untouched.approvedAt).toBeNull();
    });

    it('cannot be executed by hand by that admin either', async () => {
      const payout = await createRefundPayout();

      const response = await executeAs(actors.admin, payout.id);

      expect(response.status).toBe(403);
      expect(response.body.errorCode).toBe('MONEY_CONTROL_VIOLATION');
      expect((await readPayout(payout.id)).status).toBe('PENDING');
    });

    it('can still be executed by hand by another admin, and the provider leaves it alone', async () => {
      const payout = await createRefundPayout();

      await executeAs(secondAdmin, payout.id).expect(200);
      expect(await dispatcher.dispatchDue()).toBe(0);

      expect((await readPayout(payout.id)).mpesaReference).toBe('QGH7RT51XK');
      const ops = await operationsOf(payout.id);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        provider: 'manual',
        status: 'CONFIRMED',
        providerReference: 'QGH7RT51XK',
      });
    });
  });

  describe('when the transfer does not go through at once', () => {
    it('fails the payout on a refusal, and an admin can put it back in the queue', async () => {
      const payout = await createProviderPayout(PHONE('01'));

      await dispatcher.dispatchDue();

      const failed = await readPayout(payout.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.failReason).toContain('CUSTOMER_REJECTED');
      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payout.id}/retry`)
        .set(authHeader(secondAdmin.accessToken))
        .send({})
        .expect(200);
      expect((await readPayout(payout.id)).status).toBe('PENDING');
    });

    it('stays SENDING without an answer, closed to manual changes, until the job asks', async () => {
      const payout = await createProviderPayout(PHONE('03'));

      await dispatcher.dispatchDue();

      expect((await readPayout(payout.id)).status).toBe('SENDING');
      const execute = await executeAs(secondAdmin, payout.id);
      expect(execute.status).toBe(400);
      expect(execute.body.message).toContain(
        'Este payout está a ser enviado pelo fornecedor.',
      );
      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payout.id}/fail`)
        .set(authHeader(secondAdmin.accessToken))
        .send({ reason: 'Tentativa de falhar à mão.' })
        .expect(400);

      await pollLater();

      expect((await readPayout(payout.id)).status).toBe('EXECUTED');
    });

    it('is closed by the provider notice when the provider never answered', async () => {
      const payout = await createProviderPayout(PHONE('06'));
      await dispatcher.dispatchDue();
      const [operation] = await operationsOf(payout.id);

      await request(actors.httpServer)
        .post('/api/v1/payments/providers/simulator/events')
        .set('x-zuno-webhook-token', WEBHOOK_SECRET)
        .send({
          eventId: 'evt-payout-0001',
          reference: operation.reference,
          status: 'CONFIRMED',
          providerReference: 'SIMSENT000001',
          amount: PROVIDER_PAYOUT,
          msisdn: PHONE('06'),
        })
        .expect(200);

      const sent = await readPayout(payout.id);
      expect(sent.status).toBe('EXECUTED');
      expect(sent.mpesaReference).toBe('SIMSENT000001');
    });
  });
});
