import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { DisputesService } from '../src/modules/disputes/services/disputes.service';
import { PaymentsService } from '../src/modules/payments/services/payments.service';
import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  createHeldBooking,
  openDepositClaim,
  openPaymentDispute,
  releasePayment,
  resetBookingFlow,
  respondToDispute,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';
import { createHeldServiceBooking } from './helpers/service-flow';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STARTS_IN_DAYS = 5;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

type Outcome = 'client' | 'owner' | 'partial';

// Os jobs estão desligados em NODE_ENV=test. Os testes chamam directamente o
// método que o scheduler chamaria.
describe('Dispute lifecycle E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let disputes: DisputesService;
  let payments: PaymentsService;
  let cloudName: string;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    disputes = app.get(DisputesService);
    payments = app.get(PaymentsService);
    cloudName = app
      .get(ConfigService)
      .getOrThrow<string>('CLOUDINARY_CLOUD_NAME');
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

  /** O endereço de uma foto que `userId` carregou em /disputes/upload-evidence. */
  const evidenceOf = (userId: string, name = 'foto-1') =>
    `https://res.cloudinary.com/${cloudName}/image/upload/v1/zuno/disputes/${userId}/${name}.jpg`;

  function patchAs(token: string, path: string, body: object = {}) {
    return request(actors.httpServer)
      .patch(`/api/v1${path}`)
      .set(authHeader(token))
      .send(body);
  }

  const respondAs = (token: string, disputeId: string, body: object = {}) =>
    patchAs(token, `/disputes/${disputeId}/respond`, {
      response: 'O equipamento foi entregue no dia combinado.',
      ...body,
    });

  const withdrawAs = (token: string, disputeId: string, body: object = {}) =>
    patchAs(token, `/disputes/${disputeId}/withdraw`, body);

  const resolve = (
    disputeId: string,
    outcome: Outcome,
    body: { refundPercent?: number } = {},
  ) =>
    patchAs(
      actors.admin.accessToken,
      `/disputes/${disputeId}/resolve-${outcome}`,
      body,
    );

  function openAs(token: string, body: object) {
    return request(actors.httpServer)
      .post('/api/v1/disputes')
      .set(authHeader(token))
      .send({
        reason: 'NOT_DELIVERED',
        description: 'O que foi combinado nunca chegou a ser entregue.',
        ...body,
      });
  }

  const readDispute = (disputeId: string) =>
    prisma().dispute.findUniqueOrThrow({ where: { id: disputeId } });

  const readBooking = (bookingId: string) =>
    prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });

  const readServiceBooking = (serviceBookingId: string) =>
    prisma().serviceBooking.findUniqueOrThrow({
      where: { id: serviceBookingId },
    });

  const readPayment = (paymentId: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id: paymentId } });

  const auditsOf = (targetId: string) =>
    prisma().auditLog.findMany({
      where: { targetId },
      select: { action: true, actorId: true, metadata: true },
    });

  async function letResponseDeadlinePass(disputeId: string) {
    await prisma().dispute.update({
      where: { id: disputeId },
      data: { responseDeadline: hoursAgo(1) },
    });
  }

  /** Aluguer pago e ainda por entregar, que o cliente disputa. */
  async function createRentalDispute() {
    const held = await createHeldBooking(actors, {
      startsInDays: STARTS_IN_DAYS,
    });
    const disputeId = await openPaymentDispute(actors, {
      bookingId: held.bookingId,
      paymentId: held.paymentId,
    });

    return { ...held, disputeId };
  }

  /** Aluguer entregue, em que o provider reclama o depósito. */
  async function createDepositClaim() {
    const held = await createHeldBooking(actors, {
      startsInDays: STARTS_IN_DAYS,
    });
    await releasePayment(actors, held.paymentId);
    const disputeId = await openDepositClaim(actors, held.bookingId);

    return { ...held, disputeId };
  }

  /** Serviço pago, levado até onde o teste precisa, que o cliente disputa. */
  async function createServiceDispute(stage: 'paid' | 'started' | 'completed') {
    const held = await createHeldServiceBooking(actors);
    const bookingPath = `/service-bookings/${held.serviceBookingId}`;

    if (stage !== 'paid') {
      await patchAs(actors.provider.accessToken, `${bookingPath}/start`).expect(
        200,
      );
    }
    if (stage === 'completed') {
      await patchAs(
        actors.provider.accessToken,
        `${bookingPath}/complete`,
      ).expect(200);
    }

    const disputeId = await openPaymentDispute(actors, held);

    return { ...held, disputeId };
  }

  describe('opening', () => {
    it('gives the other party three days to answer, and says who that is', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await openAs(actors.client.accessToken, {
        bookingId,
        paymentId,
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        status: 'AWAITING_OWNER',
        openedBy: actors.client.userId,
        respondentId: actors.provider.userId,
        response: null,
        respondedAt: null,
      });
      const deadline = new Date(response.body.data.responseDeadline as string);
      const daysToAnswer = (deadline.getTime() - Date.now()) / DAY_MS;
      expect(daysToAnswer).toBeGreaterThan(2.99);
      expect(daysToAnswer).toBeLessThanOrEqual(3);
      expect((await readBooking(bookingId)).status).toBe('DISPUTED');
    });

    it('makes a deposit claim wait for the answer of the client', async () => {
      const { disputeId } = await createDepositClaim();

      const response = await request(actors.httpServer)
        .get(`/api/v1/disputes/${disputeId}`)
        .set(authHeader(actors.client.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        type: 'DEPOSIT',
        status: 'AWAITING_OWNER',
        openedBy: actors.provider.userId,
        respondentId: actors.client.userId,
      });
    });

    it('returns 400 for a second dispute while one is open', async () => {
      const { bookingId, paymentId } = await createRentalDispute();

      const response = await openAs(actors.provider.accessToken, {
        bookingId,
        paymentId,
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'Já existe uma disputa aberta nesta reserva.',
      );
      expect(await prisma().dispute.count({ where: { paymentId } })).toBe(1);
    });

    it('is refused by the database when a second open dispute is forced in', async () => {
      const { bookingId, paymentId } = await createRentalDispute();

      await expect(
        prisma().dispute.create({
          data: {
            bookingId,
            paymentId,
            openedBy: actors.provider.userId,
            reason: 'OTHER',
            description: 'Segunda disputa aberta à força, por fora do serviço.',
            status: 'UNDER_REVIEW',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma().dispute.count({ where: { paymentId } })).toBe(1);
    });
  });

  describe('evidence', () => {
    it('keeps the photos the opener uploaded', async () => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });
      const evidenceUrls = [
        evidenceOf(actors.client.userId, 'portao-fechado'),
        evidenceOf(actors.client.userId, 'conversa'),
      ];

      const response = await openAs(actors.client.accessToken, {
        bookingId,
        paymentId,
        evidenceUrls,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.evidenceUrls).toEqual(evidenceUrls);
    });

    it.each([
      [
        'a photo uploaded by someone else',
        () => [evidenceOf(actors.provider.userId)],
      ],
      ['a link to another site', () => ['https://exemplo.com/foto.jpg']],
      [
        'a photo in another Cloudinary account',
        () => [
          `https://res.cloudinary.com/outra-conta/image/upload/v1/zuno/disputes/${actors.client.userId}/foto.jpg`,
        ],
      ],
      [
        'more than ten photos',
        () =>
          Array.from({ length: 11 }, (_, index) =>
            evidenceOf(actors.client.userId, `foto-${index}`),
          ),
      ],
    ])('returns 400 for %s and opens nothing', async (_label, buildUrls) => {
      const { bookingId, paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await openAs(actors.client.accessToken, {
        bookingId,
        paymentId,
        evidenceUrls: buildUrls(),
      });

      expect(response.status).toBe(400);
      expect(await prisma().dispute.count()).toBe(0);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
    });
  });

  describe('answer', () => {
    it('lets the provider answer with their own photos, and sends the dispute to review', async () => {
      const { disputeId } = await createRentalDispute();
      const evidenceUrls = [evidenceOf(actors.provider.userId, 'entrega')];

      const response = await respondAs(actors.provider.accessToken, disputeId, {
        response: 'Entreguei a betoneira às 8h, como mostra a foto.',
        evidenceUrls,
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        status: 'UNDER_REVIEW',
        response: 'Entreguei a betoneira às 8h, como mostra a foto.',
        responseEvidenceUrls: evidenceUrls,
        // O nome antigo continua a sair, para a app que já o lê.
        ownerResponse: 'Entreguei a betoneira às 8h, como mostra a foto.',
      });
      const dispute = await readDispute(disputeId);
      expect(dispute.respondedBy).toBe(actors.provider.userId);
      expect(dispute.respondedAt).not.toBeNull();
    });

    it('lets the client answer a deposit claim', async () => {
      const { disputeId } = await createDepositClaim();

      const response = await respondAs(actors.client.accessToken, disputeId, {
        response: 'Devolvi a betoneira a funcionar.',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('UNDER_REVIEW');
      expect((await readDispute(disputeId)).respondedBy).toBe(
        actors.client.userId,
      );
    });

    it('returns 403 when the opener answers their own dispute', async () => {
      const { disputeId } = await createRentalDispute();

      const response = await respondAs(actors.client.accessToken, disputeId);

      expect(response.status).toBe(403);
      expect((await readDispute(disputeId)).status).toBe('AWAITING_OWNER');
    });

    it('returns 403 for someone outside the booking', async () => {
      const { disputeId } = await createRentalDispute();
      const outsider = await loginAsOutsider(app);

      const response = await respondAs(outsider.accessToken, disputeId);

      expect(response.status).toBe(403);
      expect((await readDispute(disputeId)).response).toBeNull();
    });

    it('lets an admin record the answer for the other party, and says so in the audit', async () => {
      const { disputeId } = await createRentalDispute();

      await respondAs(actors.admin.accessToken, disputeId, {
        response: 'Por telefone, o provider diz que entregou no dia 12.',
      }).expect(200);

      expect((await readDispute(disputeId)).respondedBy).toBe(
        actors.admin.userId,
      );
      expect(await auditsOf(disputeId)).toContainEqual({
        action: 'DISPUTE_RESPONDED',
        actorId: actors.admin.userId,
        metadata: { onBehalfOfRespondent: true },
      });
    });

    it('returns 400 for a second answer and keeps the first', async () => {
      const { disputeId } = await createRentalDispute();
      await respondAs(actors.provider.accessToken, disputeId, {
        response: 'Primeira versão.',
      }).expect(200);

      const response = await respondAs(actors.provider.accessToken, disputeId, {
        response: 'Segunda versão.',
      });

      expect(response.status).toBe(400);
      expect((await readDispute(disputeId)).response).toBe('Primeira versão.');
    });

    it('returns 400 when the answer brings the photo of someone else', async () => {
      const { disputeId } = await createRentalDispute();

      const response = await respondAs(actors.provider.accessToken, disputeId, {
        evidenceUrls: [evidenceOf(actors.client.userId)],
      });

      expect(response.status).toBe(400);
      expect((await readDispute(disputeId)).status).toBe('AWAITING_OWNER');
    });
  });

  describe('answer deadline', () => {
    it.each<Outcome>(['client', 'owner', 'partial'])(
      'refuses to resolve for the %s while the other party can still answer',
      async (outcome) => {
        const { paymentId, disputeId } = await createRentalDispute();

        const response = await resolve(
          disputeId,
          outcome,
          outcome === 'partial' ? { refundPercent: 50 } : {},
        );

        expect(response.status).toBe(400);
        expect(response.body.message).toBe(
          'A outra parte ainda pode responder a esta disputa. Só se resolve depois da resposta ou do fim do prazo.',
        );
        expect((await readPayment(paymentId)).status).toBe('HELD');
        expect(await readOutflows(paymentId)).toEqual([]);
      },
    );

    it('leaves the dispute waiting while the deadline has not passed', async () => {
      const { disputeId } = await createRentalDispute();

      const closed = await disputes.closeResponseWindows();

      expect(closed).toBe(0);
      expect((await readDispute(disputeId)).status).toBe('AWAITING_OWNER');
    });

    it('sends the dispute to review when the deadline passes without an answer', async () => {
      const { paymentId, disputeId } = await createRentalDispute();
      await letResponseDeadlinePass(disputeId);

      const closed = await disputes.closeResponseWindows();

      expect(closed).toBe(1);
      const dispute = await readDispute(disputeId);
      expect(dispute.status).toBe('UNDER_REVIEW');
      expect(dispute.response).toBeNull();
      expect(await auditsOf(disputeId)).toContainEqual({
        action: 'DISPUTE_RESPONSE_WINDOW_CLOSED',
        actorId: 'system',
        metadata: null,
      });

      // Sem resposta, o admin já pode decidir.
      await resolve(disputeId, 'client').expect(200);
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
    });

    it('still takes a late answer until the admin decides', async () => {
      const { disputeId } = await createRentalDispute();
      await letResponseDeadlinePass(disputeId);
      await disputes.closeResponseWindows();

      const response = await respondAs(actors.provider.accessToken, disputeId, {
        response: 'Só vi o aviso hoje. Entreguei no dia combinado.',
      });

      expect(response.status).toBe(200);
      const dispute = await readDispute(disputeId);
      expect(dispute.status).toBe('UNDER_REVIEW');
      expect(dispute.response).toBe(
        'Só vi o aviso hoje. Entreguei no dia combinado.',
      );
    });

    it('does not touch a dispute that was answered in time', async () => {
      const { disputeId } = await createRentalDispute();
      await respondToDispute(actors, disputeId, 'provider');
      await letResponseDeadlinePass(disputeId);

      const closed = await disputes.closeResponseWindows();

      expect(closed).toBe(0);
      expect(
        (await auditsOf(disputeId)).map(({ action }) => action),
      ).not.toContain('DISPUTE_RESPONSE_WINDOW_CLOSED');
    });
  });

  describe('withdrawal', () => {
    it('moves no money and puts the rental back to confirmed', async () => {
      const { bookingId, paymentId, disputeId } = await createRentalDispute();

      const response = await withdrawAs(actors.client.accessToken, disputeId, {
        reason: 'Falámos e ele entrega amanhã.',
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        status: 'WITHDRAWN',
        resolution: 'Falámos e ele entrega amanhã.',
      });
      expect(response.body.data.closedAt).not.toBeNull();
      expect((await readDispute(disputeId)).closedBy).toBe(
        actors.client.userId,
      );

      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
      expect((await readPayment(paymentId)).status).toBe('HELD');
      expect(await readOutflows(paymentId)).toEqual([]);
      expect(await readPayouts(paymentId)).toEqual([]);
      expect(await auditsOf(disputeId)).toContainEqual({
        action: 'DISPUTE_WITHDRAWN',
        actorId: actors.client.userId,
        metadata: { reason: 'Falámos e ele entrega amanhã.', byOpener: true },
      });
    });

    it('lets the client confirm the delivery afterwards, as in any rental', async () => {
      const { bookingId, paymentId, disputeId } = await createRentalDispute();
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      await releasePayment(actors, paymentId);

      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
      expect((await readPayment(paymentId)).status).toBe('RELEASED');
    });

    it('leaves the rental active and the deposit held when a deposit claim is withdrawn', async () => {
      const { bookingId, paymentId, disputeId } = await createDepositClaim();

      await withdrawAs(actors.provider.accessToken, disputeId).expect(200);

      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
      expect((await readPayment(paymentId)).depositStatus).toBe('HELD');

      // O caminho normal continua: o provider confirma a devolução.
      await patchAs(
        actors.provider.accessToken,
        `/bookings/${bookingId}/confirm-return`,
      ).expect(200);
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect((await readPayment(paymentId)).depositStatus).toBe('RETURNED');
    });

    it.each([
      ['paid', 'PENDING'],
      ['started', 'IN_PROGRESS'],
      ['completed', 'COMPLETED'],
    ] as const)(
      'puts a %s service back to %s',
      async (stage, statusBeforeDispute) => {
        const { serviceBookingId, paymentId, disputeId } =
          await createServiceDispute(stage);
        expect((await readServiceBooking(serviceBookingId)).status).toBe(
          'DISPUTED',
        );

        await withdrawAs(actors.client.accessToken, disputeId).expect(200);

        expect((await readServiceBooking(serviceBookingId)).status).toBe(
          statusBeforeDispute,
        );
        expect((await readPayment(paymentId)).status).toBe('HELD');
      },
    );

    it('returns 403 when the other party tries to withdraw it', async () => {
      const { bookingId, disputeId } = await createRentalDispute();

      const response = await withdrawAs(actors.provider.accessToken, disputeId);

      expect(response.status).toBe(403);
      expect((await readDispute(disputeId)).status).toBe('AWAITING_OWNER');
      expect((await readBooking(bookingId)).status).toBe('DISPUTED');
    });

    it('lets an admin archive it, and says so in the audit', async () => {
      const { bookingId, disputeId } = await createRentalDispute();

      await withdrawAs(actors.admin.accessToken, disputeId).expect(200);

      const dispute = await readDispute(disputeId);
      expect(dispute.status).toBe('WITHDRAWN');
      expect(dispute.resolution).toBe(
        'Disputa arquivada por um administrador.',
      );
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
      expect(await auditsOf(disputeId)).toContainEqual({
        action: 'DISPUTE_WITHDRAWN',
        actorId: actors.admin.userId,
        metadata: {
          reason: 'Disputa arquivada por um administrador.',
          byOpener: false,
        },
      });
    });

    it('can still be withdrawn after the other party answered', async () => {
      const { bookingId, disputeId } = await createRentalDispute();
      await respondToDispute(actors, disputeId, 'provider');

      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      expect((await readDispute(disputeId)).status).toBe('WITHDRAWN');
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
    });

    it('returns 400 for a dispute the admin already decided', async () => {
      const { paymentId, disputeId } = await createRentalDispute();
      await respondToDispute(actors, disputeId, 'provider');
      await resolve(disputeId, 'client').expect(200);

      const response = await withdrawAs(actors.client.accessToken, disputeId);

      expect(response.status).toBe(400);
      expect((await readDispute(disputeId)).status).toBe('RESOLVED_CLIENT');
      expect((await readPayment(paymentId)).status).toBe('REFUNDED');
    });

    it('returns 400 when withdrawn twice', async () => {
      const { disputeId } = await createRentalDispute();
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      const response = await withdrawAs(actors.client.accessToken, disputeId);

      expect(response.status).toBe(400);
    });

    it('refuses to resolve or answer a withdrawn dispute', async () => {
      const { paymentId, disputeId } = await createRentalDispute();
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      const resolution = await resolve(disputeId, 'owner');
      const answer = await respondAs(actors.provider.accessToken, disputeId);

      expect(resolution.status).toBe(400);
      expect(resolution.body.message).toBe('Esta disputa foi retirada.');
      expect(answer.status).toBe(400);
      expect((await readPayment(paymentId)).status).toBe('HELD');
    });

    it('lets a new dispute be opened on the same booking afterwards', async () => {
      const { bookingId, paymentId, disputeId } = await createRentalDispute();
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      const secondId = await openPaymentDispute(actors, {
        bookingId,
        paymentId,
      });

      expect(secondId).not.toBe(disputeId);
      expect(await prisma().dispute.count({ where: { paymentId } })).toBe(2);
      expect((await readBooking(bookingId)).status).toBe('DISPUTED');
    });
  });

  describe('automatic release after a withdrawal', () => {
    async function closedDaysAgo(disputeId: string, days: number) {
      await prisma().dispute.update({
        where: { id: disputeId },
        data: { closedAt: daysAgo(days) },
      });
    }

    it('waits three days from the withdrawal before releasing a rental', async () => {
      // Aluguer começado há 4 dias e pago há 6: sem disputa, já seria liberado.
      const rental = await createHeldBooking(actors, { startsInDays: 1 });
      await prisma().booking.update({
        where: { id: rental.bookingId },
        data: { startDate: daysAgo(4), endDate: daysAgo(1) },
      });
      await prisma().payment.update({
        where: { id: rental.paymentId },
        data: { heldAt: daysAgo(6) },
      });
      const disputeId = await openPaymentDispute(actors, {
        bookingId: rental.bookingId,
        paymentId: rental.paymentId,
      });
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);

      expect(await payments.autoReleaseDue()).toBe(0);
      expect((await readPayment(rental.paymentId)).status).toBe('HELD');

      await closedDaysAgo(disputeId, 4);

      expect(await payments.autoReleaseDue()).toBe(1);
      expect((await readPayment(rental.paymentId)).status).toBe('RELEASED');
    });

    it('waits three days from the withdrawal before releasing a completed service', async () => {
      const { serviceBookingId, paymentId, disputeId } =
        await createServiceDispute('completed');
      await withdrawAs(actors.client.accessToken, disputeId).expect(200);
      await prisma().serviceBooking.update({
        where: { id: serviceBookingId },
        data: { completedAt: daysAgo(10) },
      });

      expect(await payments.autoReleaseDue()).toBe(0);
      expect((await readPayment(paymentId)).status).toBe('HELD');

      await closedDaysAgo(disputeId, 4);

      expect(await payments.autoReleaseDue()).toBe(1);
      expect((await readPayment(paymentId)).status).toBe('RELEASED');
    });
  });

  describe('reading a dispute', () => {
    it('shows both sides of the story to the two parties and to the admin', async () => {
      const { disputeId } = await createRentalDispute();
      await respondAs(actors.provider.accessToken, disputeId, {
        response: 'Entreguei no dia combinado.',
        evidenceUrls: [evidenceOf(actors.provider.userId)],
      }).expect(200);

      for (const reader of [actors.client, actors.provider, actors.admin]) {
        const response = await request(actors.httpServer)
          .get(`/api/v1/disputes/${disputeId}`)
          .set(authHeader(reader.accessToken));

        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
          description: 'O que foi combinado nunca chegou a ser entregue.',
          response: 'Entreguei no dia combinado.',
          responseEvidenceUrls: [evidenceOf(actors.provider.userId)],
          payment: { depositStatus: 'HELD' },
        });
      }
    });

    it('returns 403 for someone outside the booking', async () => {
      const { disputeId } = await createRentalDispute();
      const outsider = await loginAsOutsider(app);

      const response = await request(actors.httpServer)
        .get(`/api/v1/disputes/${disputeId}`)
        .set(authHeader(outsider.accessToken));

      expect(response.status).toBe(403);
    });
  });
});
