import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
  ServiceQuoteStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { ServiceQuotesService } from './service-quotes.service';

const CLIENT_ID = 'client-uuid';
const PROVIDER_ID = 'provider-uuid';
const SERVICE_ID = 'service-uuid';
const REQUEST_ID = 'request-uuid';
const QUOTE_ID = 'quote-uuid';

const makeProvider = () => ({ id: PROVIDER_ID, role: UserRole.PROVIDER });
const makeClient = () => ({ id: CLIENT_ID, role: UserRole.CLIENT });

const makeRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  clientId: CLIENT_ID,
  status: ServiceRequestStatus.OPEN,
  isUrgent: false,
  serviceId: SERVICE_ID,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  service: {
    id: SERVICE_ID,
    providerId: PROVIDER_ID,
    acceptsUrgent: true,
    urgentSurcharge: new Prisma.Decimal(30),
  },
  ...overrides,
});

const makeQuote = (overrides: Record<string, unknown> = {}) => ({
  id: QUOTE_ID,
  requestId: REQUEST_ID,
  providerId: PROVIDER_ID,
  amount: new Prisma.Decimal(5000),
  urgentSurcharge: null,
  totalAmount: new Prisma.Decimal(5000),
  estimatedDays: 3,
  message: null,
  status: ServiceQuoteStatus.PENDING,
  expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
  provider: { id: PROVIDER_ID, name: 'Provider', avatarUrl: null },
  request: makeRequest(),
  ...overrides,
});

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  serviceRequest: { findUnique: jest.fn(), update: jest.fn() },
  serviceQuote: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  serviceBooking: { create: jest.fn() },
  payment: { create: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn(),
});

const audit = { record: jest.fn() };

describe('ServiceQuotesService', () => {
  let service: ServiceQuotesService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceQuotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ServiceQuotesService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  describe('create()', () => {
    const dto = {
      amount: 5000,
      totalAmount: 5000,
      estimatedDays: 3,
    };

    it('cria orçamento e marca request como QUOTED', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.serviceQuote.findUnique.mockResolvedValue(null);
          prisma.serviceQuote.create.mockResolvedValue(makeQuote());
          prisma.serviceRequest.update.mockResolvedValue({});
          return cb(prisma);
        },
      );

      const result = await service.create(PROVIDER_ID, REQUEST_ID, dto);

      expect(result.data.status).toBe(ServiceQuoteStatus.PENDING);
      expect(prisma.serviceRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ServiceRequestStatus.QUOTED },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SERVICE_QUOTE_SUBMITTED' }),
      );
    });

    it('rejeita não-provider', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      await expect(service.create(CLIENT_ID, REQUEST_ID, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejeita provider que não é dono do serviço', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'other-provider',
        role: UserRole.PROVIDER,
      });
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      await expect(
        service.create('other-provider', REQUEST_ID, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita request EXPIRED', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(
        makeRequest({ status: ServiceRequestStatus.EXPIRED }),
      );
      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita request com expiresAt no passado', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(
        makeRequest({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    // URGENT SURCHARGE -----------------------------------------------------
    it('urgência: valida cálculo correcto', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(
        makeRequest({ isUrgent: true }),
      );
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.serviceQuote.findUnique.mockResolvedValue(null);
          prisma.serviceQuote.create.mockResolvedValue(makeQuote());
          return cb(prisma);
        },
      );

      // amount 5000 * 30% = 1500. total = 6500
      await service.create(PROVIDER_ID, REQUEST_ID, {
        amount: 5000,
        urgentSurcharge: 1500,
        totalAmount: 6500,
        estimatedDays: 3,
      });

      expect(prisma.serviceQuote.create).toHaveBeenCalled();
    });

    it('urgência: rejeita surcharge incorrecto', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(
        makeRequest({ isUrgent: true }),
      );

      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, {
          amount: 5000,
          urgentSurcharge: 999,
          totalAmount: 5999,
          estimatedDays: 3,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('urgência: exige surcharge se isUrgent=true', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(
        makeRequest({ isUrgent: true }),
      );

      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, {
          amount: 5000,
          totalAmount: 5000,
          estimatedDays: 3,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('não-urgente: rejeita surcharge > 0', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, {
          amount: 5000,
          urgentSurcharge: 100,
          totalAmount: 5100,
          estimatedDays: 3,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('não-urgente: totalAmount tem de ser igual a amount', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      await expect(
        service.create(PROVIDER_ID, REQUEST_ID, {
          amount: 5000,
          totalAmount: 6000,
          estimatedDays: 3,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  describe('accept() — atómico', () => {
    it('aceita orçamento, cria booking + payment, rejeita outros', async () => {
      let findUniqueCount = 0;
      prisma.serviceQuote.findUnique.mockImplementation(() => {
        findUniqueCount += 1;
        // Call 1 (initial): full quote with request
        // Call 2 (inside tx): slim with PENDING status
        // Call 3 (after tx): refreshed quote
        if (findUniqueCount === 1) return Promise.resolve(makeQuote());
        if (findUniqueCount === 2)
          return Promise.resolve({
            id: QUOTE_ID,
            status: ServiceQuoteStatus.PENDING,
            requestId: REQUEST_ID,
            providerId: PROVIDER_ID,
          });
        return Promise.resolve(
          makeQuote({ status: ServiceQuoteStatus.ACCEPTED }),
        );
      });

      prisma.$transaction.mockImplementation(
        async (
          cb: (tx: typeof prisma) => Promise<unknown>,
        ): Promise<unknown> => {
          prisma.serviceRequest.findUnique.mockResolvedValueOnce({
            id: REQUEST_ID,
            clientId: CLIENT_ID,
            status: ServiceRequestStatus.QUOTED,
            serviceId: SERVICE_ID,
          });
          prisma.serviceQuote.update.mockResolvedValue({});
          prisma.serviceQuote.updateMany.mockResolvedValue({ count: 2 });
          prisma.serviceRequest.update.mockResolvedValue({});
          prisma.serviceBooking.create.mockResolvedValue({
            id: 'booking-uuid',
            status: ServiceBookingStatus.PENDING,
          });
          prisma.payment.findUnique.mockResolvedValue(null);
          prisma.payment.create.mockResolvedValue({
            id: 'payment-uuid',
            receiptNumber: 'ZUNO-XXX',
          });
          return cb(prisma);
        },
      );

      const result = await service.accept(CLIENT_ID, QUOTE_ID);

      expect(result.message).toContain('Orçamento aceite');
      expect(prisma.serviceBooking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            clientId: CLIENT_ID,
            providerId: PROVIDER_ID,
            status: ServiceBookingStatus.PENDING,
            serviceAmount: 5000,
            platformFee: 500, // 10% de 5000
            totalAmount: 5500,
          }),
        }),
      );
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.PENDING,
            method: PaymentMethod.MPESA,
          }),
        }),
      );
      expect(prisma.serviceQuote.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ServiceQuoteStatus.REJECTED },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SERVICE_QUOTE_ACCEPTED' }),
      );
    });

    it('rejeita não-dono do request', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(makeQuote());
      await expect(service.accept('outro', QUOTE_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejeita quote já não-PENDING', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(
        makeQuote({ status: ServiceQuoteStatus.REJECTED }),
      );
      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita quote expirado', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(
        makeQuote({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('race condition: re-leitura na transacção detecta que outra aceitação venceu', async () => {
      let count = 0;
      prisma.serviceQuote.findUnique.mockImplementation(() => {
        count += 1;
        // call 1 (pre-tx): PENDING
        // call 2 (inside tx, re-leitura): ja ACCEPTED (outra request venceu)
        if (count === 1) return Promise.resolve(makeQuote());
        return Promise.resolve({
          id: QUOTE_ID,
          status: ServiceQuoteStatus.ACCEPTED,
          requestId: REQUEST_ID,
          providerId: PROVIDER_ID,
        });
      });
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
      );

      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rollback total se $transaction falha a meio (booking.create falha)', async () => {
      let count = 0;
      prisma.serviceQuote.findUnique.mockImplementation(() => {
        count += 1;
        if (count === 1) return Promise.resolve(makeQuote());
        return Promise.resolve({
          id: QUOTE_ID,
          status: ServiceQuoteStatus.PENDING,
          requestId: REQUEST_ID,
          providerId: PROVIDER_ID,
        });
      });
      const dbError = new Error('DB failure during booking create');
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.serviceRequest.findUnique.mockResolvedValueOnce({
            id: REQUEST_ID,
            clientId: CLIENT_ID,
            status: ServiceRequestStatus.QUOTED,
            serviceId: SERVICE_ID,
          });
          prisma.serviceQuote.update.mockResolvedValue({});
          prisma.serviceQuote.updateMany.mockResolvedValue({ count: 0 });
          prisma.serviceRequest.update.mockResolvedValue({});
          prisma.serviceBooking.create.mockRejectedValue(dbError);
          return cb(prisma);
        },
      );

      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        'DB failure',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('findReceived() / findSent()', () => {
    it('findReceived devolve quotes para pedidos do cliente', async () => {
      prisma.serviceQuote.findMany.mockResolvedValue([makeQuote()]);
      const result = await service.findReceived(CLIENT_ID);
      expect(result.data).toHaveLength(1);
    });

    it('findSent devolve quotes do provider', async () => {
      prisma.serviceQuote.findMany.mockResolvedValue([makeQuote()]);
      const result = await service.findSent(PROVIDER_ID);
      expect(result.data).toHaveLength(1);
      const call = prisma.serviceQuote.findMany.mock.calls[0][0] as {
        where: { providerId?: string };
      };
      expect(call.where.providerId).toBe(PROVIDER_ID);
    });
  });

  describe('accept() — branches adicionais', () => {
    it('quote inexistente -> NotFound', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(null);
      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejeita se request status não é OPEN nem QUOTED', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(
        makeQuote({
          request: {
            ...makeRequest({}),
            status: ServiceRequestStatus.ACCEPTED,
          },
        }),
      );
      await expect(service.accept(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reject() / withdraw() — branches adicionais', () => {
    it('reject: quote inexistente -> NotFound', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(null);
      await expect(service.reject(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reject: quote não-PENDING', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        status: ServiceQuoteStatus.REJECTED,
        request: { clientId: CLIENT_ID },
      });
      await expect(service.reject(CLIENT_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('withdraw: quote inexistente -> NotFound', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue(null);
      await expect(service.withdraw(PROVIDER_ID, QUOTE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('withdraw: quote não-PENDING', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        providerId: PROVIDER_ID,
        status: ServiceQuoteStatus.ACCEPTED,
      });
      await expect(service.withdraw(PROVIDER_ID, QUOTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('reject() / withdraw()', () => {
    it('cliente rejeita orçamento PENDING', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        status: ServiceQuoteStatus.PENDING,
        request: { clientId: CLIENT_ID },
      });
      prisma.serviceQuote.update.mockResolvedValue(
        makeQuote({ status: ServiceQuoteStatus.REJECTED }),
      );

      const result = await service.reject(CLIENT_ID, QUOTE_ID);
      expect(result.data.status).toBe(ServiceQuoteStatus.REJECTED);
    });

    it('reject: outro user é proibido', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        status: ServiceQuoteStatus.PENDING,
        request: { clientId: CLIENT_ID },
      });
      await expect(service.reject('outro', QUOTE_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('withdraw: provider retira o seu PENDING', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        providerId: PROVIDER_ID,
        status: ServiceQuoteStatus.PENDING,
      });
      prisma.serviceQuote.update.mockResolvedValue(
        makeQuote({ status: ServiceQuoteStatus.WITHDRAWN }),
      );

      const result = await service.withdraw(PROVIDER_ID, QUOTE_ID);
      expect(result.data.status).toBe(ServiceQuoteStatus.WITHDRAWN);
    });

    it('withdraw: outro provider é proibido', async () => {
      prisma.serviceQuote.findUnique.mockResolvedValue({
        id: QUOTE_ID,
        providerId: PROVIDER_ID,
        status: ServiceQuoteStatus.PENDING,
      });
      await expect(service.withdraw('outro', QUOTE_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
