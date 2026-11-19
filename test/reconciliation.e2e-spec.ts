import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ReconciliationService } from '../src/modules/payments/services/reconciliation.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  createHeldBooking,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { createHeldServiceBooking } from './helpers/service-flow';

// Aluguer de 3 dias a 1500 MZN por dia com 5000 de depósito: o cliente paga
// 9950, o provider recebe 4050 e a plataforma fica com 900.
const TOTAL_CHARGED = 9950;
const DEPOSIT = 5000;
const PROVIDER_PAYOUT = 4050;
const PLATFORM_SHARE = 900;

describe('Money reconciliation E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let reconciliation: ReconciliationService;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    reconciliation = app.get(ReconciliationService);
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const reconcileAs = (token: string) =>
    request(actors.httpServer)
      .get('/api/v1/payments/admin/reconciliation')
      .set(authHeader(token));

  const reconcile = async () =>
    (await reconcileAs(actors.admin.accessToken).expect(200)).body.data as {
      paymentsChecked: number;
      totals: Record<string, number>;
      findingsTotal: number;
      findings: Array<{ paymentId: string; check: string; detail: string }>;
    };

  describe('who may ask', () => {
    it.each([
      ['the client', () => actors.client.accessToken],
      ['the provider', () => actors.provider.accessToken],
    ])('is closed to %s', async (_label, token) => {
      await reconcileAs(token()).expect(403);
    });

    it('is closed without a session', async () => {
      await request(actors.httpServer)
        .get('/api/v1/payments/admin/reconciliation')
        .expect(401);
    });
  });

  describe('where the money is', () => {
    it('is nowhere before anyone pays', async () => {
      const report = await reconcile();

      expect(report.paymentsChecked).toBe(0);
      expect(report.findings).toEqual([]);
      expect(report.totals).toEqual({
        received: 0,
        heldInEscrow: 0,
        owedInPayouts: 0,
        paidOut: 0,
        platformShare: 0,
        unallocatedInAccount: 0,
        providerFees: 0,
        expectedInAccount: 0,
      });
    });

    it('is all in escrow once the payment is confirmed', async () => {
      await createHeldBooking(actors, { startsInDays: 5 });

      const { totals, findings } = await reconcile();

      expect(findings).toEqual([]);
      expect(totals).toEqual({
        received: TOTAL_CHARGED,
        heldInEscrow: TOTAL_CHARGED,
        owedInPayouts: 0,
        paidOut: 0,
        platformShare: 0,
        unallocatedInAccount: 0,
        providerFees: 0,
        expectedInAccount: TOTAL_CHARGED,
      });
    });

    it('splits after the delivery: deposit held, provider owed, platform paid', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await releasePayment(actors, paymentId);

      const { totals, findings } = await reconcile();

      expect(findings).toEqual([]);
      expect(totals).toEqual({
        received: TOTAL_CHARGED,
        heldInEscrow: DEPOSIT,
        owedInPayouts: PROVIDER_PAYOUT,
        paidOut: 0,
        platformShare: PLATFORM_SHARE,
        unallocatedInAccount: 0,
        providerFees: 0,
        // Nada saiu ainda da conta: o payout está por executar.
        expectedInAccount: TOTAL_CHARGED,
      });
    });

    it('leaves the account once the payout is executed', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await releasePayment(actors, paymentId);
      const payout = await prisma().payout.findFirstOrThrow({
        where: { paymentId },
      });
      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payout.id}/execute`)
        .set(authHeader(actors.admin.accessToken))
        .send({ mpesaReference: 'QGH7RT51XK' })
        .expect(200);

      const { totals, findings } = await reconcile();

      expect(findings).toEqual([]);
      expect(totals).toMatchObject({
        owedInPayouts: 0,
        paidOut: PROVIDER_PAYOUT,
        expectedInAccount: TOTAL_CHARGED - PROVIDER_PAYOUT,
      });
      // O que está na conta é o depósito retido mais a parte da plataforma.
      expect(totals.expectedInAccount).toBe(DEPOSIT + PLATFORM_SHARE);
    });

    it('adds rentals and services together', async () => {
      await createHeldBooking(actors, { startsInDays: 5 });
      await createHeldServiceBooking(actors);

      const report = await reconcile();

      expect(report.paymentsChecked).toBe(2);
      expect(report.findings).toEqual([]);
      expect(report.totals.heldInEscrow).toBe(TOTAL_CHARGED + 5500);
    });
  });

  describe('what it catches', () => {
    it('money held in a booking that someone cancelled by hand', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await prisma().booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' },
      });

      const report = await reconcile();

      expect(report.findingsTotal).toBe(1);
      expect(report.findings[0]).toMatchObject({
        paymentId,
        check: 'RESERVATION_STATE_MISMATCH',
        detail: 'A reserva está CANCELLED com o pagamento HELD.',
      });
    });

    it('a payout that the ledger never recorded', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await prisma().payout.create({
        data: {
          paymentId,
          recipientId: actors.client.userId,
          kind: 'CLIENT_REFUND',
          amount: 1000,
          msisdn: '+258840000902',
        },
      });

      const report = await reconcile();

      expect(report.findings.map(({ check }) => check)).toEqual([
        'CLIENT_PAYOUTS_MISMATCH',
      ]);
      expect(report.findings[0].detail).toBe(
        'O ledger tem 0.00 MZN de saídas para o cliente e os payouts somam 1000.00 MZN.',
      );
    });

    it('a payment inserted as held without the money ever coming in', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      // Uma segunda reserva com um pagamento "retido" posto à mão na tabela.
      const original = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      const forged = await prisma().booking.create({
        data: {
          clientId: original.clientId,
          ownerId: original.ownerId,
          equipmentId: original.equipmentId,
          startDate: new Date(original.startDate.getTime() + 30 * 86_400_000),
          endDate: new Date(original.endDate.getTime() + 30 * 86_400_000),
          totalDays: original.totalDays,
          rentalAmount: original.rentalAmount,
          depositAmount: 0,
          platformFee: original.platformFee,
          totalAmount: 4950,
          status: 'CONFIRMED',
        },
      });
      const forgedPayment = await prisma().payment.create({
        data: {
          bookingId: forged.id,
          clientId: original.clientId,
          ownerId: original.ownerId,
          rentalAmount: original.rentalAmount,
          depositAmount: 0,
          platformFee: original.platformFee,
          totalCharged: 4950,
          ownerPayout: PROVIDER_PAYOUT,
          method: 'MPESA',
          status: 'HELD',
          heldAt: new Date(),
          receiptNumber: 'ZUNO-FORJADO-0001',
        },
      });

      const report = await reconcile();

      const forgedFindings = report.findings.filter(
        (finding) => finding.paymentId === forgedPayment.id,
      );
      expect(forgedFindings.map(({ check }) => check)).toEqual([
        'INFLOW_MISMATCH',
        'BALANCE_MISMATCH',
      ]);
      expect(
        report.findings.filter((finding) => finding.paymentId === paymentId),
      ).toEqual([]);
    });
  });

  describe('the scheduled run', () => {
    it('reports nothing when the money adds up', async () => {
      await createHeldBooking(actors, { startsInDays: 5 });

      const report = await reconciliation.runAndAlert();

      expect(report.findingsTotal).toBe(0);
    });

    it('reports what it found without failing the job', async () => {
      const { bookingId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await prisma().booking.update({
        where: { id: bookingId },
        data: { status: 'EXPIRED' },
      });

      const report = await reconciliation.runAndAlert();

      expect(report.findingsTotal).toBe(1);
    });

    it('publishes the result as metrics', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });
      await releasePayment(actors, paymentId);

      await reconciliation.run();
      const metrics = (
        await request(actors.httpServer).get('/metrics').expect(200)
      ).text;

      expect(metrics).toContain('zuno_reconciliation_findings 0');
      expect(metrics).toContain(`zuno_escrow_held_mzn ${DEPOSIT}`);
      expect(metrics).toContain(`zuno_payouts_owed_mzn ${PROVIDER_PAYOUT}`);
    });
  });
});
