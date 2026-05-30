import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  truncateAllTables,
  disconnectTestPrisma,
} from './helpers/db';
import {
  seedMinimalTestData,
  TEST_PASSWORD,
  TestSeedResult,
} from './helpers/seed-test-data';
import { loginViaApi, authHeader, LoginResult } from './helpers/auth';

/**
 * E2E para a infra de Idempotency-Key em POST /bookings.
 *
 * Garante 4 contratos:
 *   1. 1ª chamada → cria booking, devolve 201
 *   2. retry com mesma key + mesmo body → devolve mesmo booking (replay)
 *   3. retry com mesma key + body diferente → 409 IDEMPOTENCY_KEY_MISMATCH
 *   4. sem o header → 400 BAD_REQUEST
 */
describe('Idempotency E2E — POST /bookings', () => {
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let seed: TestSeedResult;
  let providerAuth: LoginResult;
  let clientAuth: LoginResult;
  let adminAuth: LoginResult;
  let equipmentId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
    httpServer = app.getHttpServer();
  }, 30000);

  beforeEach(async () => {
    await truncateAllTables();
    seed = await seedMinimalTestData();

    providerAuth = await loginViaApi(app, seed.provider.phone, TEST_PASSWORD);
    clientAuth = await loginViaApi(app, seed.client.phone, TEST_PASSWORD);
    adminAuth = await loginViaApi(app, seed.admin.phone, TEST_PASSWORD);

    // Equipment ACTIVE para ser reservável
    const created = await request(httpServer)
      .post('/api/v1/equipment')
      .set(authHeader(providerAuth.accessToken))
      .send({
        title: 'Item Idempotency E2E',
        description:
          'Equipamento de teste para verificar idempotency-key em retries.',
        categoryId: seed.categories.construcao.id,
        pricePerDay: 1000,
        depositAmount: 2000,
        location: 'Maputo',
      });
    equipmentId = created.body?.data?.id as string;

    await request(httpServer)
      .patch(`/api/v1/equipment/${equipmentId}/approve`)
      .set(authHeader(adminAuth.accessToken))
      .send({});
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  function bookingBody(extra: Partial<{ startDate: string; endDate: string }> = {}) {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() + 7);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 10);

    return {
      equipmentId,
      startDate: extra.startDate ?? startDate.toISOString(),
      endDate: extra.endDate ?? endDate.toISOString(),
    };
  }

  it('1ª chamada com Idempotency-Key cria a reserva (201)', async () => {
    const res = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .set('Idempotency-Key', 'spec-idem-001')
      .send(bookingBody());

    expect(res.status).toBe(201);
    expect(res.body?.data?.id).toBeDefined();
    expect(res.body?.data?.status).toBe('PENDING');
  });

  it('retry com MESMA key + MESMO body devolve a MESMA reserva (replay)', async () => {
    const body = bookingBody();
    const key = 'spec-idem-002';

    const res1 = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .set('Idempotency-Key', key)
      .send(body);

    const res2 = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .set('Idempotency-Key', key)
      .send(body);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res2.body?.data?.id).toBe(res1.body?.data?.id);
  });

  it('retry com MESMA key + body DIFERENTE devolve 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    const key = 'spec-idem-003';

    await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .set('Idempotency-Key', key)
      .send(bookingBody());

    // Body diferente: datas mais à frente
    const futureStart = new Date();
    futureStart.setDate(futureStart.getDate() + 30);
    const futureEnd = new Date();
    futureEnd.setDate(futureEnd.getDate() + 33);

    const mismatchRes = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .set('Idempotency-Key', key)
      .send(
        bookingBody({
          startDate: futureStart.toISOString(),
          endDate: futureEnd.toISOString(),
        }),
      );

    expect(mismatchRes.status).toBe(409);
    expect(mismatchRes.body?.errorCode).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('sem Idempotency-Key devolve 400 BAD_REQUEST', async () => {
    const res = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      // sem .set('Idempotency-Key', ...)
      .send(bookingBody());

    expect(res.status).toBe(400);
    expect(res.body?.errorCode).toBe('BAD_REQUEST');
    expect(res.body?.message).toMatch(/Idempotency-Key/i);
  });
});
