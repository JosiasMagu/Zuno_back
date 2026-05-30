import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  disconnectTestPrisma,
  getTestPrisma,
  truncateAllTables,
} from './helpers/db';
import { authHeader, loginViaApi, LoginResult } from './helpers/auth';
import {
  seedMinimalTestData,
  TEST_PASSWORD,
  TestSeedResult,
} from './helpers/seed-test-data';

describe('Happy Path E2E — service request → booking → escrow → review', () => {
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

  it('completes the full service flow (electricista, urgência, 5000 MZN)', async () => {
    // ── 1 & 2: Provider regista serviço (já registado/aprovado nas fixtures) ─
    const createServiceRes = await request(httpServer)
      .post('/api/v1/services')
      .set(authHeader(providerAuth.accessToken))
      .send({
        title: 'Reparação eléctrica residencial',
        description:
          'Diagnóstico, reparação e instalação eléctrica em residências. Resposta rápida.',
        categoryId: seed.categories.electricidade.id,
        basePrice: 5000,
        pricingType: 'FIXED',
        location: 'Maputo, Cidade',
        acceptsUrgent: true,
        urgentSurcharge: 30,
      });

    expect(createServiceRes.status).toBe(201);
    const serviceId = createServiceRes.body?.data?.id as string;
    expect(serviceId).toBeDefined();
    expect(createServiceRes.body?.data?.status).toBe('PENDING_REVIEW');

    // ── 3: Admin aprova serviço ────────────────────────────────────────────
    const approveRes = await request(httpServer)
      .patch(`/api/v1/services/${serviceId}/approve`)
      .set(authHeader(adminAuth.accessToken))
      .send({});

    expect(approveRes.status).toBe(200);
    expect(approveRes.body?.data?.status).toBe('ACTIVE');

    // ── 4: Cliente cria ServiceRequest urgente ─────────────────────────────
    const createReqRes = await request(httpServer)
      .post('/api/v1/service-requests')
      .set(authHeader(clientAuth.accessToken))
      .send({
        serviceId,
        description: 'Curto-circuito no quadro principal — preciso urgente.',
        isUrgent: true,
        address: 'Av. Eduardo Mondlane, 123, Maputo',
      });

    expect(createReqRes.status).toBe(201);
    const requestId = createReqRes.body?.data?.id as string;
    expect(requestId).toBeDefined();
    expect(createReqRes.body?.data?.status).toBe('OPEN');
    expect(createReqRes.body?.data?.isUrgent).toBe(true);

    // ── 5: Provider envia ServiceQuote (5000 base + 1500 urgência) ─────────
    const createQuoteRes = await request(httpServer)
      .post(`/api/v1/service-requests/${requestId}/quotes`)
      .set(authHeader(providerAuth.accessToken))
      .send({
        amount: 5000,
        urgentSurcharge: 1500, // 30% de 5000
        totalAmount: 6500,
        estimatedDays: 1,
        message: 'Posso ir já hoje à tarde. Inclui pequenos materiais.',
      });

    expect(createQuoteRes.status).toBe(201);
    const quoteId = createQuoteRes.body?.data?.id as string;
    expect(quoteId).toBeDefined();
    expect(createQuoteRes.body?.data?.status).toBe('PENDING');

    // ── 6: Cliente aceita o orçamento → cria booking + payment(PENDING) ────
    const acceptRes = await request(httpServer)
      .patch(`/api/v1/service-quotes/${quoteId}/accept`)
      .set(authHeader(clientAuth.accessToken))
      .send({});

    expect(acceptRes.status).toBe(200);
    const serviceBookingId = acceptRes.body?.data?.serviceBookingId as string;
    const paymentId = acceptRes.body?.data?.paymentId as string;
    expect(serviceBookingId).toBeDefined();
    expect(paymentId).toBeDefined();

    // ── 7: Admin marca Payment como HELD (escrow capturado) ────────────────
    const markHeldRes = await request(httpServer)
      .patch(`/api/v1/payments/${paymentId}/mark-held`)
      .set(authHeader(adminAuth.accessToken))
      .send({});

    expect(markHeldRes.status).toBe(200);
    expect(markHeldRes.body?.data?.status).toBe('HELD');

    // ── 8: Provider inicia execução ────────────────────────────────────────
    const startRes = await request(httpServer)
      .patch(`/api/v1/service-bookings/${serviceBookingId}/start`)
      .set(authHeader(providerAuth.accessToken))
      .send({});

    expect(startRes.status).toBe(200);
    expect(startRes.body?.data?.status).toBe('IN_PROGRESS');

    // ── 9: Provider conclui execução ───────────────────────────────────────
    const completeRes = await request(httpServer)
      .patch(`/api/v1/service-bookings/${serviceBookingId}/complete`)
      .set(authHeader(providerAuth.accessToken))
      .send({});

    expect(completeRes.status).toBe(200);
    expect(completeRes.body?.data?.status).toBe('COMPLETED');

    // ── 10: Cliente liberta escrow (Payment RELEASED) ──────────────────────
    const releaseRes = await request(httpServer)
      .patch(`/api/v1/payments/${paymentId}/release`)
      .set(authHeader(clientAuth.accessToken))
      .send({});

    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body?.data?.status).toBe('RELEASED');

    // ── 11: Cliente avalia o serviço; Provider avalia o cliente ────────────
    const clientReviewRes = await request(httpServer)
      .post('/api/v1/reviews')
      .set(authHeader(clientAuth.accessToken))
      .send({
        serviceBookingId,
        authorRole: 'CLIENT',
        rating: 5,
        comment: 'Profissional excelente, resolveu em 30 minutos.',
      });

    expect(clientReviewRes.status).toBe(201);

    const providerReviewRes = await request(httpServer)
      .post('/api/v1/reviews')
      .set(authHeader(providerAuth.accessToken))
      .send({
        serviceBookingId,
        authorRole: 'PROVIDER',
        rating: 5,
        comment: 'Cliente comunicativo e disponível.',
      });

    expect(providerReviewRes.status).toBe(201);

    // ── 12: Verificações na BD ─────────────────────────────────────────────
    const prisma = getTestPrisma();

    const finalService = await prisma.service.findUnique({
      where: { id: serviceId },
      select: { status: true, totalRating: true, totalReviews: true },
    });
    expect(finalService?.status).toBe('ACTIVE');
    expect(Number(finalService?.totalRating)).toBe(5);
    expect(finalService?.totalReviews).toBe(1);

    const finalRequest = await prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    expect(finalRequest?.status).toBe('ACCEPTED');

    const finalQuote = await prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      select: { status: true },
    });
    expect(finalQuote?.status).toBe('ACCEPTED');

    const finalBooking = await prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      select: { status: true, completedAt: true },
    });
    expect(finalBooking?.status).toBe('COMPLETED');
    expect(finalBooking?.completedAt).not.toBeNull();

    const finalPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        releasedAt: true,
        serviceBookingId: true,
        bookingId: true,
      },
    });
    expect(finalPayment?.status).toBe('RELEASED');
    expect(finalPayment?.releasedAt).not.toBeNull();
    expect(finalPayment?.serviceBookingId).toBe(serviceBookingId);
    expect(finalPayment?.bookingId).toBeNull();

    // Provider rating: actualmente recalculateUserRating agrega tambem reviews
    // de clientes nos serviços/equipamentos do provider (via serviceBooking.providerId
    // ou booking.providerId), nao só reviews directos (targetId === providerId).
    // Isto reflecte a satisfacao total do provider — bug do backlog item 7 corrigido.
    const finalProvider = await prisma.user.findUnique({
      where: { id: seed.provider.id },
      select: { totalRating: true, totalReviews: true },
    });
    expect(Number(finalProvider?.totalRating)).toBe(5);
    expect(finalProvider?.totalReviews).toBe(1);

    const finalClient = await prisma.user.findUnique({
      where: { id: seed.client.id },
      select: { totalRating: true, totalReviews: true },
    });
    expect(Number(finalClient?.totalRating)).toBe(5);
    expect(finalClient?.totalReviews).toBe(1);

    // Audit log: verificar entradas esperadas
    const auditEntries = await prisma.auditLog.findMany({
      where: {
        targetId: { in: [requestId, quoteId, serviceBookingId, paymentId] },
      },
      select: { action: true, targetId: true },
    });
    const actions = auditEntries.map((e) => e.action).sort();
    expect(actions).toEqual(
      expect.arrayContaining([
        'SERVICE_REQUEST_CREATED',
        'SERVICE_QUOTE_SUBMITTED',
        'SERVICE_QUOTE_ACCEPTED',
        'PAYMENT_INITIATED',
        'PAYMENT_MARKED_HELD',
        'SERVICE_BOOKING_STARTED',
        'SERVICE_BOOKING_COMPLETED',
        'PAYMENT_RELEASED',
      ]),
    );
  }, 60000);
});
