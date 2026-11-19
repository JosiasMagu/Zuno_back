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
  openPaymentDispute,
  paymentReceipt,
  releasePayment,
  resetBookingFlow,
  respondToDispute,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readInflows, readOutflows, readPayouts } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';

const ROUNDS = 4;
const STARTS_IN_DAYS = 5;

// Dois pedidos que mexem no mesmo dinheiro ao mesmo tempo. Só um pode ganhar,
// o outro tem de receber um erro limpo, e o estado final tem de ser um dos
// dois que cada pedido deixaria sozinho.
describe('Concurrent money moves E2E', () => {
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

  /** Abre várias ligações à base, para os pedidos seguintes se cruzarem de facto. */
  async function openConnections() {
    await Promise.all(
      Array.from({ length: 4 }, () =>
        request(actors.httpServer).get('/api/v1/equipment'),
      ),
    );
  }

  async function readState(bookingId: string) {
    const booking = await prisma().booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { payment: true, disputes: true },
    });

    return {
      booking: booking.status,
      payment: booking.payment?.status,
      deposit: booking.payment?.depositStatus,
      disputed: booking.disputes.length > 0,
    };
  }

  function expectOneWinner(statuses: number[]) {
    const [winner, loser] = [...statuses].sort();

    expect(winner).toBeLessThan(300);
    expect(loser).toBeGreaterThanOrEqual(400);
    expect(loser).toBeLessThan(500);
  }

  it('the client confirming delivery while the provider opens a dispute', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      await openConnections();

      const [release, dispute] = await Promise.all([
        request(actors.httpServer)
          .patch(`/api/v1/payments/${paymentId}/release`)
          .set(authHeader(actors.client.accessToken))
          .send({}),
        request(actors.httpServer)
          .post('/api/v1/disputes')
          .set(authHeader(actors.provider.accessToken))
          .send({
            bookingId,
            paymentId,
            reason: 'OTHER',
            description: 'O cliente recusou-se a receber o equipamento.',
          }),
      ]);

      expectOneWinner([release.status, dispute.status]);
      expect([
        {
          booking: 'ACTIVE',
          payment: 'RELEASED',
          deposit: 'HELD',
          disputed: false,
        },
        {
          booking: 'DISPUTED',
          payment: 'HELD',
          deposit: 'HELD',
          disputed: true,
        },
      ]).toContainEqual(await readState(bookingId));
    }
  });

  it('the provider confirming the return while claiming the deposit', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      await releasePayment(actors, paymentId);
      await openConnections();

      const [confirmReturn, claim] = await Promise.all([
        request(actors.httpServer)
          .patch(`/api/v1/bookings/${bookingId}/confirm-return`)
          .set(authHeader(actors.provider.accessToken))
          .send({}),
        request(actors.httpServer)
          .post('/api/v1/disputes/deposit-claim')
          .set(authHeader(actors.provider.accessToken))
          .send({
            bookingId,
            description: 'A betoneira foi devolvida com o motor queimado.',
          }),
      ]);

      expectOneWinner([confirmReturn.status, claim.status]);
      expect([
        {
          booking: 'COMPLETED',
          payment: 'RELEASED',
          deposit: 'RETURNED',
          disputed: false,
        },
        {
          booking: 'DISPUTED',
          payment: 'RELEASED',
          deposit: 'HELD',
          disputed: true,
        },
      ]).toContainEqual(await readState(bookingId));
    }
  });

  const patchAs = (token: string, path: string, body: object = {}) =>
    request(actors.httpServer)
      .patch(`/api/v1${path}`)
      .set(authHeader(token))
      .send(body);

  it('the client confirming the same delivery twice', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      await openConnections();

      const [first, second] = await Promise.all([
        patchAs(actors.client.accessToken, `/payments/${paymentId}/release`),
        patchAs(actors.client.accessToken, `/payments/${paymentId}/release`),
      ]);

      expectOneWinner([first.status, second.status]);
      // O provider é pago uma vez só.
      expect(await readPayouts(paymentId)).toEqual([
        'PROVIDER_PAYOUT:4050:PENDING',
      ]);
      expect(await readOutflows(paymentId)).toEqual([
        'PLATFORM:900',
        'PROVIDER:4050',
      ]);
      expect((await readState(bookingId)).payment).toBe('RELEASED');
    }
  });

  it('two confirmations of the same payment with different references', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS + round * 5,
      );
      await confirmBooking(actors, bookingId);
      const paymentId = await initiatePayment(actors, bookingId);
      const [oneReceipt, otherReceipt] = await Promise.all([
        paymentReceipt(paymentId),
        paymentReceipt(paymentId),
      ]);
      await openConnections();

      const [first, second] = await Promise.all([
        patchAs(
          actors.admin.accessToken,
          `/payments/${paymentId}/mark-held`,
          oneReceipt,
        ),
        patchAs(
          actors.admin.accessToken,
          `/payments/${paymentId}/mark-held`,
          otherReceipt,
        ),
      ]);

      expectOneWinner([first.status, second.status]);
      // O dinheiro entra no escrow uma vez só.
      expect(await readInflows(paymentId)).toEqual(['CLIENT:9950']);
    }
  });

  it('the admin refunding while the client confirms the delivery', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      await openConnections();

      const [release, refund] = await Promise.all([
        patchAs(actors.client.accessToken, `/payments/${paymentId}/release`),
        patchAs(actors.admin.accessToken, `/payments/${paymentId}/refund`),
      ]);

      expectOneWinner([release.status, refund.status]);
      expect([
        {
          booking: 'ACTIVE',
          payment: 'RELEASED',
          deposit: 'HELD',
          disputed: false,
        },
        {
          booking: 'CANCELLED',
          payment: 'REFUNDED',
          deposit: 'RETURNED',
          disputed: false,
        },
      ]).toContainEqual(await readState(bookingId));
    }
  });

  it('two executions of the same payout with different references', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      await releasePayment(actors, paymentId);
      const payout = await prisma().payout.findFirstOrThrow({
        where: { paymentId },
      });
      await openConnections();

      const [first, second] = await Promise.all([
        patchAs(actors.admin.accessToken, `/payouts/${payout.id}/execute`, {
          mpesaReference: `REFA${round}00001`,
        }),
        patchAs(actors.admin.accessToken, `/payouts/${payout.id}/execute`, {
          mpesaReference: `REFB${round}00001`,
        }),
      ]);

      expectOneWinner([first.status, second.status]);
      const executed = await prisma().payout.findUniqueOrThrow({
        where: { id: payout.id },
      });
      expect(executed.status).toBe('EXECUTED');
      expect([`REFA${round}00001`, `REFB${round}00001`]).toContain(
        executed.mpesaReference,
      );
    }
  });

  it('the admin resolving the same dispute in two opposite ways', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS + round * 5,
      });
      const disputeId = await openPaymentDispute(actors, {
        bookingId,
        paymentId,
      });
      await respondToDispute(actors, disputeId, 'provider');
      await openConnections();

      const [forClient, forOwner] = await Promise.all([
        patchAs(
          actors.admin.accessToken,
          `/disputes/${disputeId}/resolve-client`,
        ),
        patchAs(
          actors.admin.accessToken,
          `/disputes/${disputeId}/resolve-owner`,
        ),
      ]);

      expectOneWinner([forClient.status, forOwner.status]);
      const dispute = await prisma().dispute.findUniqueOrThrow({
        where: { id: disputeId },
      });
      const { payment } = await readState(bookingId);
      // O dinheiro segue uma decisão só, a que ficou escrita na disputa.
      expect(['RESOLVED_CLIENT:REFUNDED', 'RESOLVED_OWNER:RELEASED']).toContain(
        `${dispute.status}:${payment}`,
      );
    }
  });
});
