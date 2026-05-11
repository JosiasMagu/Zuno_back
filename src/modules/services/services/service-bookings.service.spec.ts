import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus, ServiceBookingStatus, UserRole } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { ServiceBookingsService } from './service-bookings.service';

const CLIENT_ID = 'client-uuid';
const PROVIDER_ID = 'provider-uuid';
const ADMIN_ID = 'admin-uuid';
const BOOKING_ID = 'booking-uuid';

const makeClient = () => ({ id: CLIENT_ID, role: UserRole.CLIENT });
const makeProvider = () => ({ id: PROVIDER_ID, role: UserRole.PROVIDER });
const makeAdmin = () => ({ id: ADMIN_ID, role: UserRole.ADMIN });

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  providerId: PROVIDER_ID,
  serviceId: 'service-uuid',
  requestId: 'request-uuid',
  quoteId: 'quote-uuid',
  scheduledFor: null,
  isUrgent: false,
  serviceAmount: 5000,
  platformFee: 500,
  totalAmount: 5500,
  status: ServiceBookingStatus.PENDING,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  service: { id: 'service-uuid', title: 'Serviço' },
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  provider: { id: PROVIDER_ID, name: 'Provider', avatarUrl: null },
  payment: {
    id: 'payment-uuid',
    status: PaymentStatus.HELD,
    receiptNumber: 'ZUNO-X',
  },
  ...overrides,
});

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  serviceBooking: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
});

const audit = { record: jest.fn() };

describe('ServiceBookingsService', () => {
  let service: ServiceBookingsService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceBookingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ServiceBookingsService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  describe('start()', () => {
    it('PROVIDER inicia booking PENDING com Payment HELD', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.IN_PROGRESS }),
      );

      const result = await service.start(PROVIDER_ID, BOOKING_ID);

      expect(result.data.status).toBe(ServiceBookingStatus.IN_PROGRESS);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SERVICE_BOOKING_STARTED' }),
      );
    });

    it('rejeita não-provider', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      await expect(service.start(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejeita booking não-PENDING', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.IN_PROGRESS }),
      );
      await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita se Payment não está HELD', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({
          payment: {
            id: 'p',
            status: PaymentStatus.PENDING,
            receiptNumber: 'X',
          },
        }),
      );
      await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita se não há Payment', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({ payment: null }),
      );
      await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('complete()', () => {
    it('PROVIDER conclui IN_PROGRESS', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        providerId: PROVIDER_ID,
        status: ServiceBookingStatus.IN_PROGRESS,
      });
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.COMPLETED }),
      );

      const result = await service.complete(PROVIDER_ID, BOOKING_ID);
      expect(result.data.status).toBe(ServiceBookingStatus.COMPLETED);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SERVICE_BOOKING_COMPLETED' }),
      );
    });

    it('rejeita non-provider', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        providerId: PROVIDER_ID,
        status: ServiceBookingStatus.IN_PROGRESS,
      });
      await expect(service.complete(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejeita complete sem ter iniciado (PENDING)', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        providerId: PROVIDER_ID,
        status: ServiceBookingStatus.PENDING,
      });
      await expect(service.complete(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('cancel()', () => {
    it('CLIENT cancela PENDING quando Payment PENDING', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({
          payment: {
            id: 'p',
            status: PaymentStatus.PENDING,
            receiptNumber: 'X',
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.CANCELLED }),
      );

      const result = await service.cancel(CLIENT_ID, BOOKING_ID, {});
      expect(result.data.status).toBe(ServiceBookingStatus.CANCELLED);
    });

    it('CLIENT não cancela IN_PROGRESS — deve abrir disputa', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.IN_PROGRESS }),
      );
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('Payment já HELD: não-admin não pode cancelar', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({
          payment: { id: 'p', status: PaymentStatus.HELD, receiptNumber: 'X' },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(makeProvider());

      await expect(service.cancel(PROVIDER_ID, BOOKING_ID, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('ADMIN pode forçar cancel mesmo com Payment HELD', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({
          payment: { id: 'p', status: PaymentStatus.HELD, receiptNumber: 'X' },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.CANCELLED }),
      );

      const result = await service.cancel(ADMIN_ID, BOOKING_ID, {
        reason: 'Resolução de incidente',
      });
      expect(result.data.status).toBe(ServiceBookingStatus.CANCELLED);
    });

    it('rejeita se já está COMPLETED', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.COMPLETED }),
      );
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita user que não é parte', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro',
        role: UserRole.CLIENT,
      });

      await expect(service.cancel('outro', BOOKING_ID, {})).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('findOne()', () => {
    it('cliente acede', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue(makeClient());
      const result = await service.findOne(CLIENT_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('outro user é proibido', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro',
        role: UserRole.CLIENT,
      });
      await expect(service.findOne('outro', BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('booking inexistente -> NotFound', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(null);
      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('user inexistente -> NotFound', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOne('inexistente', BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findMine() / findForProvider()', () => {
    it('findMine filtra por clientId', async () => {
      prisma.serviceBooking.findMany.mockResolvedValue([]);
      prisma.serviceBooking.count.mockResolvedValue(0);

      await service.findMine(CLIENT_ID, { page: 1, limit: 10 });

      const call = prisma.serviceBooking.findMany.mock.calls[0][0] as {
        where: { clientId?: string };
      };
      expect(call.where.clientId).toBe(CLIENT_ID);
    });

    it('findForProvider filtra por providerId', async () => {
      prisma.serviceBooking.findMany.mockResolvedValue([]);
      prisma.serviceBooking.count.mockResolvedValue(0);

      await service.findForProvider(PROVIDER_ID, { page: 1, limit: 10 });

      const call = prisma.serviceBooking.findMany.mock.calls[0][0] as {
        where: { providerId?: string };
      };
      expect(call.where.providerId).toBe(PROVIDER_ID);
    });

    it('aplica filtro de status quando passado', async () => {
      prisma.serviceBooking.findMany.mockResolvedValue([]);
      prisma.serviceBooking.count.mockResolvedValue(0);

      await service.findMine(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: ServiceBookingStatus.IN_PROGRESS,
      });

      const call = prisma.serviceBooking.findMany.mock.calls[0][0] as {
        where: { status?: string };
      };
      expect(call.where.status).toBe(ServiceBookingStatus.IN_PROGRESS);
    });
  });

  describe('cancel() — branches adicionais', () => {
    it('booking inexistente -> NotFound', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(null);
      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
