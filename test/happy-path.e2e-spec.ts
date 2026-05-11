import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  truncateAllTables,
  disconnectTestPrisma,
  getTestPrisma,
} from './helpers/db';
import {
  seedMinimalTestData,
  TEST_PASSWORD,
  TestSeedResult,
} from './helpers/seed-test-data';
import { loginViaApi, authHeader, LoginResult } from './helpers/auth';

describe('Happy Path E2E — equipment rental full flow', () => {
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let seed: TestSeedResult;
  let providerAuth: LoginResult;
  let clientAuth: LoginResult;
  let adminAuth: LoginResult;

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
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  it('completes the full equipment rental flow end to end', async () => {
    // ── Step 1: Provider cria equipamento ──────────────────────────────────
    const createEqRes = await request(httpServer)
      .post('/api/v1/equipment')
      .set(authHeader(providerAuth.accessToken))
      .send({
        title: 'Betoneira E2E',
        description:
          'Betoneira eletrica de 300L para testes E2E. Excelente estado de conservacao.',
        categoryId: seed.categories.construcao.id,
        pricePerDay: 1500,
        depositAmount: 5000,
        location: 'Maputo, Cidade',
        condition: 'EXCELLENT',
      });

    expect(createEqRes.status).toBe(201);
    const equipmentId = createEqRes.body?.data?.id as string;
    expect(equipmentId).toBeDefined();
    expect(createEqRes.body?.data?.status).toBe('PENDING_REVIEW');

    // ── Step 2: Admin aprova equipamento ───────────────────────────────────
    const approveRes = await request(httpServer)
      .patch(`/api/v1/equipment/${equipmentId}/approve`)
      .set(authHeader(adminAuth.accessToken))
      .send({});

    expect(approveRes.status).toBe(200);
    expect(approveRes.body?.data?.status).toBe('ACTIVE');

    // ── Step 3: Client cria booking ────────────────────────────────────────
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() + 1);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 4);

    const createBookingRes = await request(httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(clientAuth.accessToken))
      .send({
        equipmentId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });

    expect(createBookingRes.status).toBe(201);
    const bookingId = createBookingRes.body?.data?.id as string;
    expect(bookingId).toBeDefined();
    expect(createBookingRes.body?.data?.status).toBe('PENDING');

    // ── Step 4: Provider confirma booking ──────────────────────────────────
    const confirmBookingRes = await request(httpServer)
      .patch(`/api/v1/bookings/${bookingId}/confirm`)
      .set(authHeader(providerAuth.accessToken))
      .send({});

    expect(confirmBookingRes.status).toBe(200);
    expect(confirmBookingRes.body?.data?.status).toBe('CONFIRMED');

    // ── Step 5: Client inicia pagamento ────────────────────────────────────
    const initiatePaymentRes = await request(httpServer)
      .post(`/api/v1/payments/booking/${bookingId}/initiate`)
      .set(authHeader(clientAuth.accessToken))
      .send({
        method: 'MPESA',
      });

    expect(initiatePaymentRes.status).toBe(201);
    const paymentId = initiatePaymentRes.body?.data?.id as string;
    expect(paymentId).toBeDefined();
    expect(initiatePaymentRes.body?.data?.status).toBe('PENDING');

    // ── Step 6: Admin marca pagamento como HELD ────────────────────────────
    const markHeldRes = await request(httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(adminAuth.accessToken))
      .send({});

    expect(markHeldRes.status).toBe(200);
    expect(markHeldRes.body?.data?.status).toBe('HELD');

    // ── Step 7: Client liberta pagamento ───────────────────────────────────
    const releaseRes = await request(httpServer)
      .patch(`/api/v1/payments/${paymentId}/release`)
      .set(authHeader(clientAuth.accessToken))
      .send({});

    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body?.data?.status).toBe('RELEASED');

    // ── Step 8: Client submete review ──────────────────────────────────────
    const reviewRes = await request(httpServer)
      .post('/api/v1/reviews')
      .set(authHeader(clientAuth.accessToken))
      .send({
        bookingId,
        authorRole: 'CLIENT',
        rating: 5,
        comment: 'Equipamento em excelente estado, provider profissional.',
      });

    expect(reviewRes.status).toBe(201);
    expect(reviewRes.body?.data?.id).toBeDefined();
    expect(reviewRes.body?.data?.rating).toBe(5);

    // ── Verificacao final na BD ────────────────────────────────────────────
    const prisma = getTestPrisma();

    const finalEq = await prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { status: true },
    });
    expect(finalEq?.status).toBe('ACTIVE');

    const finalBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    expect(finalBooking?.status).toBe('COMPLETED');

    const finalPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, releasedAt: true },
    });
    expect(finalPayment?.status).toBe('RELEASED');
    expect(finalPayment?.releasedAt).not.toBeNull();

    const finalReviewCount = await prisma.review.count({
      where: { bookingId },
    });
    expect(finalReviewCount).toBe(1);
  }, 30000);
});
