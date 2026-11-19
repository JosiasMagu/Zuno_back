import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BookingsService } from '../src/modules/bookings/services/bookings.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  createHeldBooking,
  isListedAsFree,
  openDepositClaim,
  openPaymentDispute,
  releasePayment,
  resetBookingFlow,
  respondToDispute,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import { createHeldServiceBooking } from './helpers/service-flow';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Aluguer de 3 dias a 1500 MZN por dia, com 5000 de depósito. O cliente paga
// o aluguer, 10% de taxa e o depósito; o provider recebe o aluguer menos 10%.
const RENTAL = 4500;
const DEPOSIT = 5000;
const TOTAL_CHARGED = 9950;
const PROVIDER_PAYOUT = 4050;
const PLATFORM_TAKE = 900;

// Serviço orçamentado em 5000 MZN, sem depósito.
const SERVICE_TOTAL_CHARGED = 5500;
const SERVICE_PROVIDER_PAYOUT = 4500;
const SERVICE_PLATFORM_TAKE = 1000;

const STARTS_IN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

type Outcome = 'client' | 'owner' | 'partial';

describe('Dispute resolution E2E', () => {
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

  function resolveAs(
    token: string,
    disputeId: string,
    outcome: Outcome,
    body: { refundPercent?: number } = {},
  ) {
    return request(actors.httpServer)
      .patch(`/api/v1/disputes/${disputeId}/resolve-${outcome}`)
      .set(authHeader(token))
      .send(body);
  }

  function resolve(
    disputeId: string,
    outcome: Outcome,
    refundPercent?: number,
  ) {
    return resolveAs(
      actors.admin.accessToken,
      disputeId,
      outcome,
      refundPercent === undefined ? {} : { refundPercent },
    );
  }

  /**
   * O cliente disputa um pagamento retido, antes de confirmar a entrega, e o
   * provider responde. A disputa fica em análise, pronta para o admin.
   */
  async function createPaymentDispute(depositAmount?: number) {
    const held = await createHeldBooking(actors, {
      startsInDays: STARTS_IN_DAYS,
      depositAmount,
    });
    const disputeId = await openPaymentDispute(actors, {
      bookingId: held.bookingId,
      paymentId: held.paymentId,
    });
    await respondToDispute(actors, disputeId, 'provider');

    return { ...held, disputeId };
  }

  /** O provider reclama o depósito depois de o cliente confirmar a entrega. */
  async function createDepositDispute() {
    const held = await createHeldBooking(actors, {
      startsInDays: STARTS_IN_DAYS,
    });
    await releasePayment(actors, held.paymentId);
    const disputeId = await openDepositClaim(actors, held.bookingId);
    await respondToDispute(actors, disputeId, 'client');

    return { ...held, disputeId };
  }

  async function createServiceDispute() {
    const held = await createHeldServiceBooking(actors);
    const disputeId = await openPaymentDispute(actors, held);
    await respondToDispute(actors, disputeId, 'provider');

    return { ...held, disputeId };
  }

  function readPayment(paymentId: string) {
    return prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  function readBooking(bookingId: string) {
    return prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });
  }

  function readServiceBooking(serviceBookingId: string) {
    return prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });
  }

  function readDispute(disputeId: string) {
    return prisma().dispute.findUniqueOrThrow({ where: { id: disputeId } });
  }

  /** As datas da reserva em disputa estão livres para outra reserva? */
  function datesAreFree(equipmentId: string) {
    return isListedAsFree(actors, equipmentId, STARTS_IN_DAYS);
  }

  /** Linhas de auditoria que a resolução deixou, no formato "ACÇÃO:valor". */
  async function readAudit(disputeId: string) {
    const audits = await prisma().auditLog.findMany({
      where: {
        targetId: disputeId,
        action: {
          in: [
            'DISPUTE_RESOLVED_CLIENT',
            'DISPUTE_RESOLVED_OWNER',
            'DISPUTE_RESOLVED_PARTIAL',
            'DEPOSIT_CLAIMED',
          ],
        },
      },
      select: { action: true, amount: true },
    });
    return audits.map((a) => `${a.action}:${Number(a.amount)}`);
  }

  describe('payment dispute on an equipment booking', () => {
    it('in favour of the client: refunds everything and cancels the booking', async () => {
      const { equipmentId, bookingId, paymentId, disputeId } =
        await createPaymentDispute();
      expect(await datesAreFree(equipmentId)).toBe(false);

      const response = await resolve(disputeId, 'client');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('RESOLVED_CLIENT');

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('REFUNDED');
      expect(Number(payment.refundAmount)).toBe(TOTAL_CHARGED);
      expect(Number(payment.ownerPayout)).toBe(0);
      expect(payment.depositStatus).toBe('RETURNED');

      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('CANCELLED');
      expect(booking.cancellationReason).toBe(
        'Cancelada por resolução de disputa a favor do cliente.',
      );
      expect(await datesAreFree(equipmentId)).toBe(true);

      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${TOTAL_CHARGED}:PENDING`,
      ]);
      expect((await readDispute(disputeId)).resolution).toBe(
        'Resolvido a favor do cliente.',
      );
      expect(await readAudit(disputeId)).toEqual([
        `DISPUTE_RESOLVED_CLIENT:${TOTAL_CHARGED}`,
      ]);
    });

    it('in favour of the owner: pays the provider and keeps the deposit until the return', async () => {
      const { equipmentId, bookingId, paymentId, disputeId } =
        await createPaymentDispute();

      const response = await resolve(disputeId, 'owner');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('RESOLVED_OWNER');

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('RELEASED');
      expect(payment.releasedAt).not.toBeNull();
      expect(payment.depositStatus).toBe('HELD');

      // A entrega fica dada como feita. O equipamento ainda está com o
      // cliente, por isso a reserva continua viva e as datas ocupadas.
      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('ACTIVE');
      expect(booking.deliveryConfirmedAt).not.toBeNull();
      expect(booking.returnConfirmedAt).toBeNull();
      expect(await datesAreFree(equipmentId)).toBe(false);

      expect(await readOutflows(paymentId)).toEqual([
        `PLATFORM:${PLATFORM_TAKE}`,
        `PROVIDER:${PROVIDER_PAYOUT}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
      expect(await readAudit(disputeId)).toEqual([
        `DISPUTE_RESOLVED_OWNER:${TOTAL_CHARGED}`,
      ]);
    });

    it('in favour of the owner: the deposit goes back when the provider confirms the return', async () => {
      const { bookingId, paymentId, disputeId } = await createPaymentDispute();
      await resolve(disputeId, 'owner').expect(200);

      await request(actors.httpServer)
        .patch(`/api/v1/bookings/${bookingId}/confirm-return`)
        .set(authHeader(actors.provider.accessToken))
        .send({})
        .expect(200);

      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect((await readPayment(paymentId)).depositStatus).toBe('RETURNED');
      expect(await readPayouts(paymentId)).toEqual([
        `DEPOSIT_RETURN:${DEPOSIT}:PENDING`,
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
    });

    it('in favour of the owner: the provider can still claim the deposit for damage', async () => {
      const { bookingId, paymentId, disputeId } = await createPaymentDispute();
      await resolve(disputeId, 'owner').expect(200);

      // Uma segunda disputa na mesma reserva, agora sobre o depósito.
      const claimId = await openDepositClaim(actors, bookingId);
      await respondToDispute(actors, claimId, 'client');
      await resolve(claimId, 'owner').expect(200);

      expect(claimId).not.toBe(disputeId);
      expect((await readPayment(paymentId)).depositStatus).toBe('CLAIMED');
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect(await readPayouts(paymentId)).toEqual([
        `DEPOSIT_CLAIM:${DEPOSIT}:PENDING`,
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
    });

    it('in favour of the owner without a deposit: has no deposit to return', async () => {
      const { paymentId, disputeId } = await createPaymentDispute(0);

      const response = await resolve(disputeId, 'owner');

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).depositStatus).toBe('NONE');
      expect(await readOutflows(paymentId)).toEqual([
        `PLATFORM:${PLATFORM_TAKE}`,
        `PROVIDER:${PROVIDER_PAYOUT}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`,
      ]);
    });

    it('partial: splits the rental by the refund percentage', async () => {
      const { bookingId, paymentId, disputeId } = await createPaymentDispute();
      const refund = RENTAL * 0.4;
      const providerPayout = RENTAL - refund - RENTAL * 0.1;

      const response = await resolve(disputeId, 'partial', 40);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('RESOLVED_PARTIAL');

      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('PARTIALLY_REFUNDED');
      expect(Number(payment.refundAmount)).toBe(refund);
      expect(Number(payment.ownerPayout)).toBe(providerPayout);
      // O depósito não entra na repartição: continua retido até à devolução.
      expect(payment.depositStatus).toBe('HELD');
      expect((await readBooking(bookingId)).status).toBe('ACTIVE');

      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${refund}`,
        `PLATFORM:${PLATFORM_TAKE}`,
        `PROVIDER:${providerPayout}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${refund}:PENDING`,
        `PROVIDER_PAYOUT:${providerPayout}:PENDING`,
      ]);

      const dispute = await readDispute(disputeId);
      expect(dispute.refundPercent).toBe(40);
      expect(dispute.resolution).toBe(
        'Resolvido parcialmente com reembolso de 40%.',
      );
      expect(await readAudit(disputeId)).toEqual([
        `DISPUTE_RESOLVED_PARTIAL:${refund}`,
      ]);
    });

    it('partial at 99%: the provider gets nothing once the fee is kept', async () => {
      const { paymentId, disputeId } = await createPaymentDispute();
      const refund = RENTAL * 0.99;
      const platformRetained = TOTAL_CHARGED - DEPOSIT - refund;

      const response = await resolve(disputeId, 'partial', 99);

      expect(response.status).toBe(200);
      expect(Number((await readPayment(paymentId)).ownerPayout)).toBe(0);
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${refund}`,
        `PLATFORM:${platformRetained}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${refund}:PENDING`,
      ]);
    });

    describe('after a partial resolution, the rental goes on to its end', () => {
      const refund = RENTAL * 0.4;
      const providerPayout = RENTAL - refund - RENTAL * 0.1;

      async function createSplitRental() {
        const rental = await createPaymentDispute();
        await resolve(rental.disputeId, 'partial', 40).expect(200);
        return rental;
      }

      it('returns the deposit when the provider confirms the return', async () => {
        const { bookingId, paymentId } = await createSplitRental();

        await request(actors.httpServer)
          .patch(`/api/v1/bookings/${bookingId}/confirm-return`)
          .set(authHeader(actors.provider.accessToken))
          .send({})
          .expect(200);

        const payment = await readPayment(paymentId);
        expect(payment.status).toBe('PARTIALLY_REFUNDED');
        expect(payment.depositStatus).toBe('RETURNED');
        expect((await readBooking(bookingId)).status).toBe('COMPLETED');
        expect(await readPayouts(paymentId)).toEqual([
          `CLIENT_REFUND:${refund}:PENDING`,
          `DEPOSIT_RETURN:${DEPOSIT}:PENDING`,
          `PROVIDER_PAYOUT:${providerPayout}:PENDING`,
        ]);
      });

      it('returns the deposit by itself when nobody closes the rental', async () => {
        const { bookingId, paymentId } = await createSplitRental();
        await prisma().booking.update({
          where: { id: bookingId },
          data: {
            startDate: daysAgo(8),
            endDate: daysAgo(5),
            deliveryConfirmedAt: daysAgo(4),
          },
        });

        const returned = await app.get(BookingsService).autoReturnDepositsDue();

        expect(returned).toBe(1);
        expect((await readPayment(paymentId)).depositStatus).toBe('RETURNED');
        expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      });

      it('lets the provider claim the deposit, which can be split as well', async () => {
        const { bookingId, paymentId } = await createSplitRental();

        const claimId = await openDepositClaim(actors, bookingId);
        await respondToDispute(actors, claimId, 'client');
        await resolve(claimId, 'partial', 50).expect(200);

        const payment = await readPayment(paymentId);
        expect(payment.status).toBe('PARTIALLY_REFUNDED');
        expect(payment.depositStatus).toBe('SPLIT');
        expect((await readBooking(bookingId)).status).toBe('COMPLETED');
        expect(await readPayouts(paymentId)).toEqual([
          `CLIENT_REFUND:${refund}:PENDING`,
          `DEPOSIT_CLAIM:${DEPOSIT / 2}:PENDING`,
          `DEPOSIT_RETURN:${DEPOSIT / 2}:PENDING`,
          `PROVIDER_PAYOUT:${providerPayout}:PENDING`,
        ]);
      });
    });
  });

  describe('deposit dispute', () => {
    // O release já tinha pago o provider e a plataforma; a resolução só
    // decide o destino do depósito.
    const releaseOutflows = [
      `PLATFORM:${PLATFORM_TAKE}`,
      `PROVIDER:${PROVIDER_PAYOUT}`,
    ];
    const releasePayout = `PROVIDER_PAYOUT:${PROVIDER_PAYOUT}:PENDING`;

    it('in favour of the client: returns the deposit', async () => {
      const { equipmentId, bookingId, paymentId, disputeId } =
        await createDepositDispute();

      const response = await resolve(disputeId, 'client');

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('RELEASED');
      expect(payment.depositStatus).toBe('RETURNED');
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect(await datesAreFree(equipmentId)).toBe(true);

      expect(await readOutflows(paymentId)).toEqual(
        [`CLIENT:${DEPOSIT}`, ...releaseOutflows].sort(),
      );
      expect(await readPayouts(paymentId)).toEqual(
        [`DEPOSIT_RETURN:${DEPOSIT}:PENDING`, releasePayout].sort(),
      );
      expect(await readAudit(disputeId)).toEqual([
        `DISPUTE_RESOLVED_CLIENT:${DEPOSIT}`,
      ]);
    });

    it('in favour of the owner: gives the deposit to the provider', async () => {
      const { bookingId, paymentId, disputeId } = await createDepositDispute();

      const response = await resolve(disputeId, 'owner');

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).depositStatus).toBe('CLAIMED');
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');

      expect(await readOutflows(paymentId)).toEqual(
        [`PROVIDER:${DEPOSIT}`, ...releaseOutflows].sort(),
      );
      expect(await readPayouts(paymentId)).toEqual(
        [`DEPOSIT_CLAIM:${DEPOSIT}:PENDING`, releasePayout].sort(),
      );
      expect(await readAudit(disputeId)).toEqual([
        `DEPOSIT_CLAIMED:${DEPOSIT}`,
      ]);
    });

    it('partial: splits the deposit by the refund percentage', async () => {
      const { bookingId, paymentId, disputeId } = await createDepositDispute();
      const clientPart = DEPOSIT * 0.4;
      const providerPart = DEPOSIT - clientPart;

      const response = await resolve(disputeId, 'partial', 40);

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).depositStatus).toBe('SPLIT');
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');

      expect(await readOutflows(paymentId)).toEqual(
        [
          `CLIENT:${clientPart}`,
          `PROVIDER:${providerPart}`,
          ...releaseOutflows,
        ].sort(),
      );
      expect(await readPayouts(paymentId)).toEqual(
        [
          `DEPOSIT_RETURN:${clientPart}:PENDING`,
          `DEPOSIT_CLAIM:${providerPart}:PENDING`,
          releasePayout,
        ].sort(),
      );
      expect(await readAudit(disputeId)).toEqual([
        `DISPUTE_RESOLVED_PARTIAL:${clientPart}`,
      ]);
    });
  });

  describe('payment dispute on a service booking', () => {
    it('in favour of the client: refunds and cancels the service booking', async () => {
      const { serviceBookingId, paymentId, disputeId } =
        await createServiceDispute();

      const response = await resolve(disputeId, 'client');

      expect(response.status).toBe(200);
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
      const serviceBooking = await readServiceBooking(serviceBookingId);
      expect(serviceBooking.status).toBe('CANCELLED');
      expect(serviceBooking.cancellationReason).toBe(
        'Cancelada por resolução de disputa a favor do cliente.',
      );
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${SERVICE_TOTAL_CHARGED}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `CLIENT_REFUND:${SERVICE_TOTAL_CHARGED}:PENDING`,
      ]);
    });

    it('in favour of the owner: pays the provider and completes the service booking', async () => {
      const { serviceBookingId, paymentId, disputeId } =
        await createServiceDispute();

      const response = await resolve(disputeId, 'owner');

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('RELEASED');
      expect(payment.depositStatus).toBe('NONE');
      const serviceBooking = await readServiceBooking(serviceBookingId);
      expect(serviceBooking.status).toBe('COMPLETED');
      expect(serviceBooking.completedAt).not.toBeNull();
      expect(await readOutflows(paymentId)).toEqual([
        `PLATFORM:${SERVICE_PLATFORM_TAKE}`,
        `PROVIDER:${SERVICE_PROVIDER_PAYOUT}`,
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        `PROVIDER_PAYOUT:${SERVICE_PROVIDER_PAYOUT}:PENDING`,
      ]);
    });

    it('partial: splits the service amount by the refund percentage', async () => {
      const { serviceBookingId, paymentId, disputeId } =
        await createServiceDispute();

      const response = await resolve(disputeId, 'partial', 40);

      expect(response.status).toBe(200);
      const payment = await readPayment(paymentId);
      expect(payment.status).toBe('PARTIALLY_REFUNDED');
      expect(Number(payment.refundAmount)).toBe(2000);
      expect(Number(payment.ownerPayout)).toBe(2500);
      expect((await readServiceBooking(serviceBookingId)).status).toBe(
        'COMPLETED',
      );
      expect(await readOutflows(paymentId)).toEqual([
        'CLIENT:2000',
        `PLATFORM:${SERVICE_PLATFORM_TAKE}`,
        'PROVIDER:2500',
      ]);
      expect(await readPayouts(paymentId)).toEqual([
        'CLIENT_REFUND:2000:PENDING',
        'PROVIDER_PAYOUT:2500:PENDING',
      ]);
    });
  });

  describe('refusals', () => {
    it.each<Outcome>(['client', 'owner', 'partial'])(
      'returns 403 to a non-admin on resolve-%s',
      async (outcome) => {
        const { paymentId, disputeId } = await createPaymentDispute();

        const response = await resolveAs(
          actors.provider.accessToken,
          disputeId,
          outcome,
          { refundPercent: 40 },
        );

        expect(response.status).toBe(403);
        expect((await readPayment(paymentId)).status).toBe('HELD');
      },
    );

    it('returns 400 when the dispute is already resolved', async () => {
      const { paymentId, disputeId } = await createPaymentDispute();
      await resolve(disputeId, 'client').expect(200);

      const response = await resolve(disputeId, 'owner');

      expect(response.status).toBe(400);
      expect(await readPayouts(paymentId)).toHaveLength(1);
    });

    it('returns 404 for an unknown dispute', async () => {
      const response = await resolve(randomUUID(), 'client');

      expect(response.status).toBe(404);
    });

    it.each([0, 100, 12.5])(
      'returns 400 for a refund percentage of %p',
      async (refundPercent) => {
        const { paymentId, disputeId } = await createPaymentDispute();

        const response = await resolve(disputeId, 'partial', refundPercent);

        expect(response.status).toBe(400);
        expect((await readPayment(paymentId)).status).toBe('HELD');
      },
    );
  });
});
