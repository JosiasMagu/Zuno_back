import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

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
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Reserva de 3 dias a 1500 MZN por dia, com 5000 de depósito. O cliente paga
// o aluguer, 10% de taxa e o depósito; o provider recebe o aluguer menos 10%.
const TOTAL_CHARGED = 9950;
const PROVIDER_PAYOUT = 4050;
const PLATFORM_TAKE = 900;

const STARTS_IN_DAYS = 5;

describe('Payment release and refund E2E', () => {
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

  function releaseAs(token: string, paymentId: string) {
    return request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/release`)
      .set(authHeader(token))
      .send({});
  }

  function refundAs(token: string, paymentId: string) {
    return request(actors.httpServer)
      .patch(`/api/v1/payments/${paymentId}/refund`)
      .set(authHeader(token))
      .send({});
  }

  function readPayment(paymentId: string) {
    return prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  function readBooking(bookingId: string) {
    return prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });
  }

  function countAudits(
    action: 'PAYMENT_RELEASED' | 'PAYMENT_REFUNDED',
    id: string,
  ) {
    return prisma().auditLog.count({ where: { action, targetId: id } });
  }

  /** Reserva confirmada cujo pagamento foi iniciado mas ainda não entrou. */
  async function createUnpaidBooking() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, STARTS_IN_DAYS);
    await confirmBooking(actors, bookingId);
    const paymentId = await initiatePayment(actors, bookingId);

    return { bookingId, paymentId };
  }

  describe('release', () => {
    it('pays the provider, keeps the deposit held and activates the booking', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await releaseAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('RELEASED');
      expect(response.body.data.booking.status).toBe('ACTIVE');

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('RELEASED');
      expect(payment.releasedAt).not.toBeNull();
      expect(payment.depositStatus).toBe('HELD');
      expect(payment.depositReleasedAt).toBeNull();

      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('ACTIVE');
      expect(booking.deliveryConfirmedAt).not.toBeNull();

      expect(await readOutflows(paymentId)).toEqual([
        `PLATFORM:${PLATFORM_TAKE}`,
        `PROVIDER:${PROVIDER_PAYOUT}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
      expect(await countAudits('PAYMENT_RELEASED', paymentId)).toBe(1);
    });

    it('leaves nothing held when the equipment has no deposit', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
        depositAmount: 0,
      });

      const response = await releaseAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.depositStatus).toBe('NONE');
      expect(payment.depositReleasedAt).not.toBeNull();
    });

    it('lets an admin release on behalf of the client', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await releaseAs(actors.admin.accessToken, paymentId);

      expect(response.status).toBe(200);
      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
    });

    it('returns 403 to the provider', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await releaseAs(actors.provider.accessToken, paymentId);

      expect(response.status).toBe(403);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 400 while the payment has not entered escrow', async () => {
      const { paymentId } = await createUnpaidBooking();

      const response = await releaseAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(400);
    });

    it('returns 400 on a second release and pays the provider only once', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      await releaseAs(actors.client.accessToken, paymentId).expect(200);

      const response = await releaseAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(400);
      expect(await readPayouts(paymentId)).toHaveLength(1);
    });

    it('returns 400 while a dispute is open', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      await request(actors.httpServer)
        .post('/api/v1/disputes')
        .set(authHeader(actors.client.accessToken))
        .send({
          bookingId,
          paymentId,
          reason: 'NOT_DELIVERED',
          description: 'O equipamento nunca foi entregue.',
        })
        .expect(201);

      const response = await releaseAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });
  });

  describe('refund', () => {
    it('returns the full amount to the client and cancels the booking', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await refundAs(actors.admin.accessToken, paymentId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('REFUNDED');
      expect(payment.refundedAt).not.toBeNull();
      expect(Number(payment.refundAmount)).toBe(TOTAL_CHARGED);
      expect(payment.depositStatus).toBe('RETURNED');

      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('CANCELLED');
      expect(booking.cancellationReason).toBe(
        'Reserva cancelada por reembolso do pagamento.',
      );

      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${TOTAL_CHARGED}:PENDING`,
      ]);
      expect(await countAudits('PAYMENT_REFUNDED', paymentId)).toBe(1);
    });

    it('voids the payment, with no refund recorded, when the money never entered escrow', async () => {
      const { bookingId, paymentId } = await createUnpaidBooking();

      const response = await refundAs(actors.admin.accessToken, paymentId);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('FAILED');
      expect(payment.refundAmount).toBeNull();
      expect(payment.refundedAt).toBeNull();
      expect((await readBooking(bookingId)).status).toBe('CANCELLED');
      expect(await readOutflows(paymentId)).toEqual([]);
      expect(await readPayouts(paymentId)).toEqual([]);

      const audit = await prisma().auditLog.findFirstOrThrow({
        where: { action: 'PAYMENT_REFUNDED', targetId: paymentId },
      });
      expect(audit.amount).toBeNull();
      expect(audit.metadata).toEqual({ moneyWasHeld: false });
    });

    it('returns 403 to the client', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await refundAs(actors.client.accessToken, paymentId);

      expect(response.status).toBe(403);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('returns 400 after the payment was released', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      await releaseAs(actors.client.accessToken, paymentId).expect(200);

      const response = await refundAs(actors.admin.accessToken, paymentId);

      expect(response.status).toBe(400);
    });

    it('returns 404 for an unknown payment', async () => {
      const response = await refundAs(actors.admin.accessToken, randomUUID());

      expect(response.status).toBe(404);
    });

    it('frees the dates when the refunded booking was confirmed', async () => {
      const { equipmentId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        false,
      );

      await refundAs(actors.admin.accessToken, paymentId).expect(200);

      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        true,
      );
      await createBooking(actors, equipmentId, STARTS_IN_DAYS);
    });
  });
});
