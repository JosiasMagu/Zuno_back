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
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readInflows, readOutflows } from './helpers/escrow-state';

// Aluguer de 3 dias a 1500 MZN por dia com 5000 de depósito: o cliente paga
// 9950, o provider recebe 4050 e a plataforma fica com 900.
const TOTAL_CHARGED = 9950;
const PROVIDER_PAYOUT = 4050;

/**
 * Corre uma escrita que a base de dados tem de recusar e devolve a mensagem
 * da recusa. Falha o teste se a base a aceitar.
 */
async function refusalOf(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('A base de dados aceitou uma escrita que devia recusar.');
}

// Estas regras também estão no código. Aqui prova-se que valem na própria
// base, para quem escreve nas tabelas sem passar pelos serviços: um caminho
// novo que se esqueça delas, um script, alguém com acesso directo.
describe('Money safety net in the database E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  /** Escreve uma linha no ledger directamente na tabela, sem o LedgerService. */
  const writeLedgerEntry = (
    paymentId: string,
    direction: 'INFLOW' | 'OUTFLOW',
    amount: number,
  ) =>
    prisma().ledgerEntry.create({
      data: {
        paymentId,
        direction,
        party: 'CLIENT',
        amount,
        reason: 'Escrita directa na tabela, fora do serviço.',
      },
    });

  /** Pagamento iniciado e ainda por entrar. */
  async function createPendingPayment() {
    const equipmentId = await createApprovedEquipment(actors);
    const bookingId = await createBooking(actors, equipmentId, 5);
    await confirmBooking(actors, bookingId);

    return initiatePayment(actors, bookingId);
  }

  /** Entrega confirmada: o provider tem um payout por executar. */
  async function createPendingPayout() {
    const { paymentId } = await createHeldBooking(actors, { startsInDays: 5 });
    await releasePayment(actors, paymentId);
    const payout = await prisma().payout.findFirstOrThrow({
      where: { paymentId },
    });

    return { paymentId, payoutId: payout.id };
  }

  const executePayout = (payoutId: string, mpesaReference: string) =>
    request(actors.httpServer)
      .patch(`/api/v1/payouts/${payoutId}/execute`)
      .set(authHeader(actors.admin.accessToken))
      .send({ mpesaReference });

  describe('the ledger', () => {
    it('refuses to change an entry', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        prisma().ledgerEntry.updateMany({
          where: { paymentId },
          data: { amount: 1 },
        }),
      );

      expect(refusal).toContain('o ledger só aceita INSERT');
      expect(await readInflows(paymentId)).toEqual([`CLIENT:${TOTAL_CHARGED}`]);
    });

    it('refuses to delete an entry', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        prisma().ledgerEntry.deleteMany({ where: { paymentId } }),
      );

      expect(refusal).toContain('o ledger só aceita INSERT');
      expect(await readInflows(paymentId)).toEqual([`CLIENT:${TOTAL_CHARGED}`]);
    });

    it.each([0, -100])('refuses an entry of %s MZN', async (amount) => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        writeLedgerEntry(paymentId, 'INFLOW', amount),
      );

      expect(refusal).toContain('LedgerEntry_amount_positive');
    });

    it('refuses money out of a payment that received none', async () => {
      const paymentId = await createPendingPayment();

      const refusal = await refusalOf(
        writeLedgerEntry(paymentId, 'OUTFLOW', 1),
      );

      expect(refusal).toContain('excede o saldo');
      expect(await readOutflows(paymentId)).toEqual([]);
    });

    it('refuses one cent more than what is left in escrow', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        writeLedgerEntry(paymentId, 'OUTFLOW', TOTAL_CHARGED + 0.01),
      );

      expect(refusal).toContain('excede o saldo');
      expect(await readOutflows(paymentId)).toEqual([]);
    });

    it('accepts money out up to exactly what is left in escrow', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      await writeLedgerEntry(paymentId, 'OUTFLOW', TOTAL_CHARGED);

      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
    });

    it('lets only one of two simultaneous withdrawals of the whole balance through', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const results = await Promise.allSettled([
        writeLedgerEntry(paymentId, 'OUTFLOW', TOTAL_CHARGED),
        writeLedgerEntry(paymentId, 'OUTFLOW', TOTAL_CHARGED),
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(await readOutflows(paymentId)).toEqual([
        `CLIENT:${TOTAL_CHARGED}`,
      ]);
    });
  });

  describe('the state of a payment', () => {
    it.each(['PENDING', 'FAILED'] as const)(
      'cannot go from HELD back to %s',
      async (status) => {
        const { paymentId } = await createHeldBooking(actors, {
          startsInDays: 5,
        });

        const refusal = await refusalOf(
          prisma().payment.update({
            where: { id: paymentId },
            data: { status },
          }),
        );

        expect(refusal).toContain('transição de estado ilegal');
        expect((await readPayment(paymentId)).status).toBe('HELD');
      },
    );

    it.each(['RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const)(
      'cannot jump from PENDING to %s without the money coming in',
      async (status) => {
        const paymentId = await createPendingPayment();

        const refusal = await refusalOf(
          prisma().payment.update({
            where: { id: paymentId },
            data: { status },
          }),
        );

        expect(refusal).toContain('transição de estado ilegal');
        expect((await readPayment(paymentId)).status).toBe('PENDING');
      },
    );

    it.each(['HELD', 'REFUNDED', 'PENDING'] as const)(
      'cannot leave RELEASED for %s',
      async (status) => {
        const { paymentId } = await createHeldBooking(actors, {
          startsInDays: 5,
        });
        await releasePayment(actors, paymentId);

        const refusal = await refusalOf(
          prisma().payment.update({
            where: { id: paymentId },
            data: { status },
          }),
        );

        expect(refusal).toContain('transição de estado ilegal');
        expect((await readPayment(paymentId)).status).toBe('RELEASED');
      },
    );

    it('keeps the amount charged for ever', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        prisma().payment.update({
          where: { id: paymentId },
          data: { totalCharged: 1 },
        }),
      );

      expect(refusal).toContain('não mudam depois de criado');
      expect(Number((await readPayment(paymentId)).totalCharged)).toBe(
        TOTAL_CHARGED,
      );
    });

    it('keeps who paid and who is paid for ever', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        prisma().payment.update({
          where: { id: paymentId },
          data: { ownerId: actors.admin.userId },
        }),
      );

      expect(refusal).toContain('não mudam depois de criado');
    });

    it('does not let a held deposit go back to none', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      const refusal = await refusalOf(
        prisma().payment.update({
          where: { id: paymentId },
          data: { depositStatus: 'NONE' },
        }),
      );

      expect(refusal).toContain('transição ilegal do depósito');
      expect((await readPayment(paymentId)).depositStatus).toBe('HELD');
    });

    it('cannot be deleted', async () => {
      const paymentId = await createPendingPayment();

      const refusal = await refusalOf(
        prisma().payment.delete({ where: { id: paymentId } }),
      );

      expect(refusal).toContain('um registo financeiro não se apaga');
      expect(await prisma().payment.count()).toBe(1);
    });

    it('still follows the legal path through the API', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: 5,
      });

      await releasePayment(actors, paymentId);

      expect((await readPayment(paymentId)).status).toBe('RELEASED');
    });
  });

  describe('a payout', () => {
    it('cannot be marked executed without a reference, a number and an author', async () => {
      const { payoutId } = await createPendingPayout();

      const refusal = await refusalOf(
        prisma().payout.update({
          where: { id: payoutId },
          data: { status: 'EXECUTED' },
        }),
      );

      expect(refusal).toContain('só se executa com referência');
      expect(
        (await prisma().payout.findUniqueOrThrow({ where: { id: payoutId } }))
          .status,
      ).toBe('PENDING');
    });

    it('keeps its amount for ever', async () => {
      const { payoutId } = await createPendingPayout();

      const refusal = await refusalOf(
        prisma().payout.update({
          where: { id: payoutId },
          data: { amount: 999999 },
        }),
      );

      expect(refusal).toContain('não mudam depois de criado');
    });

    it('keeps its recipient for ever', async () => {
      const { payoutId } = await createPendingPayout();

      const refusal = await refusalOf(
        prisma().payout.update({
          where: { id: payoutId },
          data: { recipientId: actors.admin.userId },
        }),
      );

      expect(refusal).toContain('não mudam depois de criado');
    });

    it('does not change once executed', async () => {
      const { payoutId } = await createPendingPayout();
      await executePayout(payoutId, 'QGH7RT51XK').expect(200);

      const refusal = await refusalOf(
        prisma().payout.update({
          where: { id: payoutId },
          data: { msisdn: '+258850000111' },
        }),
      );

      expect(refusal).toContain('um payout executado já não muda');
      const payout = await prisma().payout.findUniqueOrThrow({
        where: { id: payoutId },
      });
      expect(payout.status).toBe('EXECUTED');
      expect(Number(payout.amount)).toBe(PROVIDER_PAYOUT);
    });

    it('cannot be deleted', async () => {
      const { payoutId } = await createPendingPayout();

      const refusal = await refusalOf(
        prisma().payout.delete({ where: { id: payoutId } }),
      );

      expect(refusal).toContain('um registo financeiro não se apaga');
    });

    it('cannot share its M-Pesa reference with another payout', async () => {
      const first = await createPendingPayout();
      await executePayout(first.payoutId, 'QGH7RT51XK').expect(200);
      // Segundo payout, de outra reserva do mesmo equipamento mais à frente.
      const second = await createPendingPayout();

      const refusal = await refusalOf(
        prisma().payout.update({
          where: { id: second.payoutId },
          data: {
            status: 'EXECUTED',
            mpesaReference: 'QGH7RT51XK',
            msisdn: '+258840000901',
            executedById: actors.admin.userId,
          },
        }),
      );

      expect(refusal).toContain('mpesaReference');
    });
  });

  describe('executing a payout through the API', () => {
    it('answers 409 to a reference that already closed another payout', async () => {
      const first = await createPendingPayout();
      await executePayout(first.payoutId, 'QGH7RT51XK').expect(200);
      const second = await createPendingPayout();

      const response = await executePayout(second.payoutId, ' qgh7rt51xk ');

      expect(response.status).toBe(409);
      expect(response.body.errorCode).toBe('PAYOUT_REFERENCE_ALREADY_USED');
      expect(
        (
          await prisma().payout.findUniqueOrThrow({
            where: { id: second.payoutId },
          })
        ).status,
      ).toBe('PENDING');
    });

    it('refuses a destination number that is not a Mozambican mobile', async () => {
      const { payoutId } = await createPendingPayout();

      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payoutId}/execute`)
        .set(authHeader(actors.admin.accessToken))
        .send({ mpesaReference: 'QGH7RT51XK', msisdn: '+351912345678' })
        .expect(400);
    });

    it('leaves a trail when the money goes to a number other than the registered one', async () => {
      const { payoutId } = await createPendingPayout();

      await request(actors.httpServer)
        .patch(`/api/v1/payouts/${payoutId}/execute`)
        .set(authHeader(actors.admin.accessToken))
        .send({ mpesaReference: 'QGH7RT51XK', msisdn: '85 000 0111' })
        .expect(200);

      const [audit] = await prisma().auditLog.findMany({
        where: { targetId: payoutId, action: 'PAYOUT_EXECUTED' },
      });
      expect(audit.metadata).toMatchObject({
        msisdn: '+258850000111',
        registeredMsisdn: '+258840000901',
        msisdnOverridden: true,
      });
    });

    it('answers 404 for a payout that does not exist', async () => {
      await executePayout(randomUUID(), 'QGH7RT51XK').expect(404);
    });
  });
});
