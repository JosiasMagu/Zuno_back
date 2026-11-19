import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request, { Response } from 'supertest';

import { authHeader, loginViaApi, LoginResult } from './auth';
import { getTestPrisma, truncateAllTables } from './db';
import {
  seedMinimalTestData,
  TEST_PASSWORD,
  TestSeedResult,
} from './seed-test-data';

export interface BookingFlowActors {
  httpServer: ReturnType<INestApplication['getHttpServer']>;
  seed: TestSeedResult;
  provider: LoginResult;
  client: LoginResult;
  admin: LoginResult;
}

export const PRICE_PER_DAY = 1500;
export const RENTAL_DAYS = 3;
export const DEPOSIT_AMOUNT = 5000;

export function assertStatus(
  step: string,
  response: Response,
  expected: number,
) {
  if (response.status !== expected) {
    throw new Error(
      `${step}: esperava ${expected}, recebi ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** Limpa a base, repõe os dados mínimos e autentica os três intervenientes. */
export async function resetBookingFlow(
  app: INestApplication,
): Promise<BookingFlowActors> {
  await truncateAllTables();
  const seed = await seedMinimalTestData();

  return {
    httpServer: app.getHttpServer(),
    seed,
    provider: await loginViaApi(app, seed.provider.phone, TEST_PASSWORD),
    client: await loginViaApi(app, seed.client.phone, TEST_PASSWORD),
    admin: await loginViaApi(app, seed.admin.phone, TEST_PASSWORD),
  };
}

/** O provider publica um equipamento e o admin aprova-o. Devolve o id. */
export async function createApprovedEquipment(
  actors: BookingFlowActors,
  { depositAmount = DEPOSIT_AMOUNT, quantity = 1 } = {},
): Promise<string> {
  const created = await request(actors.httpServer)
    .post('/api/v1/equipment')
    .set(authHeader(actors.provider.accessToken))
    .send({
      title: 'Betoneira E2E',
      description:
        'Betoneira eletrica de 300L para testes E2E. Excelente estado de conservacao.',
      categoryId: actors.seed.categories.construcao.id,
      pricePerDay: PRICE_PER_DAY,
      depositAmount,
      quantity,
      location: 'Maputo, Cidade',
      condition: 'EXCELLENT',
    });
  assertStatus('criar equipamento', created, 201);
  const equipmentId = created.body.data.id as string;

  const approved = await request(actors.httpServer)
    .patch(`/api/v1/equipment/${equipmentId}/approve`)
    .set(authHeader(actors.admin.accessToken))
    .send({});
  assertStatus('aprovar equipamento', approved, 200);

  return equipmentId;
}

/**
 * O cliente reserva RENTAL_DAYS dias, a começar daqui a `startsInDays` dias.
 * Devolve o id da reserva, em estado PENDING.
 */
export async function createBooking(
  actors: BookingFlowActors,
  equipmentId: string,
  startsInDays: number,
): Promise<string> {
  const response = await request(actors.httpServer)
    .post('/api/v1/bookings')
    .set(authHeader(actors.client.accessToken))
    .set('Idempotency-Key', randomUUID())
    .send({
      equipmentId,
      startDate: daysFromToday(startsInDays),
      endDate: daysFromToday(startsInDays + RENTAL_DAYS),
    });
  assertStatus('criar reserva', response, 201);

  return response.body.data.id as string;
}

/**
 * O catálogo lista o equipamento como livre para uma reserva de RENTAL_DAYS
 * dias a começar daqui a `startsInDays` dias?
 */
export async function isListedAsFree(
  actors: BookingFlowActors,
  equipmentId: string,
  startsInDays: number,
): Promise<boolean> {
  const response = await request(actors.httpServer)
    .get('/api/v1/equipment')
    .query({
      availableFrom: daysFromToday(startsInDays),
      availableTo: daysFromToday(startsInDays + RENTAL_DAYS),
    });
  assertStatus('listar equipamentos livres no período', response, 200);

  const listed = response.body.data as Array<{ id: string }>;
  return listed.some((equipment) => equipment.id === equipmentId);
}

export async function confirmBooking(
  actors: BookingFlowActors,
  bookingId: string,
): Promise<void> {
  const response = await request(actors.httpServer)
    .patch(`/api/v1/bookings/${bookingId}/confirm`)
    .set(authHeader(actors.provider.accessToken))
    .send({});
  assertStatus('confirmar reserva', response, 200);
}

/** O cliente inicia o pagamento. Devolve o id do pagamento, em estado PENDING. */
export async function initiatePayment(
  actors: BookingFlowActors,
  bookingId: string,
): Promise<string> {
  const response = await request(actors.httpServer)
    .post(`/api/v1/payments/booking/${bookingId}/initiate`)
    .set(authHeader(actors.client.accessToken))
    .send({ method: 'MPESA' });
  assertStatus('iniciar pagamento', response, 201);

  return response.body.data.id as string;
}

/**
 * O que o admin lê no extracto M-Pesa para dar um pagamento como recebido:
 * uma referência nova, o total do pagamento e o número de onde veio.
 */
export async function paymentReceipt(paymentId: string) {
  const payment = await getTestPrisma().payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { totalCharged: true },
  });

  return {
    mpesaReference: `E2E${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
    receivedAmount: Number(payment.totalCharged),
    payerMsisdn: '+258840000902',
  };
}

/** O cliente inicia o pagamento e o admin marca-o como recebido (HELD). */
export async function holdPayment(
  actors: BookingFlowActors,
  bookingId: string,
): Promise<string> {
  const paymentId = await initiatePayment(actors, bookingId);

  const response = await request(actors.httpServer)
    .patch(`/api/v1/payments/${paymentId}/mark-held`)
    .set(authHeader(actors.admin.accessToken))
    .send(await paymentReceipt(paymentId));
  assertStatus('marcar pagamento como retido', response, 200);

  return paymentId;
}

/**
 * Reserva confirmada e com o pagamento retido, pronta para cancelar, liberar
 * ou reembolsar.
 */
export async function createHeldBooking(
  actors: BookingFlowActors,
  options: { startsInDays: number; depositAmount?: number },
): Promise<{ equipmentId: string; bookingId: string; paymentId: string }> {
  const equipmentId = await createApprovedEquipment(actors, {
    depositAmount: options.depositAmount,
  });
  const bookingId = await createBooking(
    actors,
    equipmentId,
    options.startsInDays,
  );
  await confirmBooking(actors, bookingId);
  const paymentId = await holdPayment(actors, bookingId);

  return { equipmentId, bookingId, paymentId };
}

/** O cliente confirma a entrega: o aluguer é liberado e a reserva fica ACTIVE. */
export async function releasePayment(
  actors: BookingFlowActors,
  paymentId: string,
): Promise<void> {
  const response = await request(actors.httpServer)
    .patch(`/api/v1/payments/${paymentId}/release`)
    .set(authHeader(actors.client.accessToken))
    .send({});
  assertStatus('liberar pagamento', response, 200);
}

/**
 * O cliente abre uma disputa sobre um pagamento retido, de uma reserva de
 * equipamento ou de serviço. Devolve o id da disputa.
 */
export async function openPaymentDispute(
  actors: BookingFlowActors,
  target: { bookingId?: string; serviceBookingId?: string; paymentId: string },
): Promise<string> {
  const response = await request(actors.httpServer)
    .post('/api/v1/disputes')
    .set(authHeader(actors.client.accessToken))
    .send({
      ...target,
      reason: 'NOT_DELIVERED',
      description: 'O que foi combinado nunca chegou a ser entregue.',
    });
  assertStatus('abrir disputa', response, 201);

  return response.body.data.id as string;
}

/**
 * O provider reclama o depósito por dano, com a reserva ACTIVE. Devolve o id
 * da disputa.
 */
export async function openDepositClaim(
  actors: BookingFlowActors,
  bookingId: string,
): Promise<string> {
  const response = await request(actors.httpServer)
    .post('/api/v1/disputes/deposit-claim')
    .set(authHeader(actors.provider.accessToken))
    .send({
      bookingId,
      description: 'A betoneira foi devolvida com o motor queimado.',
    });
  assertStatus('reclamar depósito', response, 201);

  return response.body.data.id as string;
}

/**
 * A outra parte responde à disputa, que segue para análise. Só depois disso,
 * ou do fim do prazo de resposta, um admin a pode resolver.
 */
export async function respondToDispute(
  actors: BookingFlowActors,
  disputeId: string,
  respondent: 'client' | 'provider',
): Promise<void> {
  const response = await request(actors.httpServer)
    .patch(`/api/v1/disputes/${disputeId}/respond`)
    .set(authHeader(actors[respondent].accessToken))
    .send({ response: 'Não foi assim que aconteceu. A minha versão é outra.' });
  assertStatus('responder à disputa', response, 200);
}
