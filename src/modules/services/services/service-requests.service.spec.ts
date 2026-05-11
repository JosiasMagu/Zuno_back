import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  ServiceRequestStatus,
  ServiceStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { ServiceRequestsService } from './service-requests.service';

const CLIENT_ID = 'client-uuid';
const PROVIDER_ID = 'provider-uuid';
const ADMIN_ID = 'admin-uuid';
const SERVICE_ID = 'service-uuid';
const REQUEST_ID = 'request-uuid';

const makeClient = () => ({ id: CLIENT_ID, role: UserRole.CLIENT });
const makeProvider = () => ({ id: PROVIDER_ID, role: UserRole.PROVIDER });
const makeAdmin = () => ({ id: ADMIN_ID, role: UserRole.ADMIN });

const makeService = (overrides: Record<string, unknown> = {}) => ({
  id: SERVICE_ID,
  title: 'Reparação eléctrica',
  providerId: PROVIDER_ID,
  basePrice: new Prisma.Decimal(1500),
  urgentSurcharge: new Prisma.Decimal(30),
  acceptsUrgent: true,
  status: ServiceStatus.ACTIVE,
  isActive: true,
  ...overrides,
});

const makeRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  clientId: CLIENT_ID,
  serviceId: SERVICE_ID,
  description: 'Preciso de reparação',
  preferredDate: null,
  isUrgent: false,
  address: 'Av. Eduardo Mondlane, 123',
  latitude: null,
  longitude: null,
  status: ServiceRequestStatus.OPEN,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
  service: makeService(),
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  ...overrides,
});

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  service: { findUnique: jest.fn() },
  serviceRequest: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  serviceQuote: { updateMany: jest.fn() },
  $transaction: jest.fn(),
});

const audit = { record: jest.fn() };

describe('ServiceRequestsService', () => {
  let service: ServiceRequestsService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ServiceRequestsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create()', () => {
    const dto = {
      serviceId: SERVICE_ID,
      description: 'Preciso de reparação',
      address: 'Av. Eduardo Mondlane, 123',
      isUrgent: false,
    };

    it('cliente cria pedido com sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.service.findUnique.mockResolvedValue(makeService());
      prisma.serviceRequest.create.mockResolvedValue(makeRequest());

      const result = await service.create(CLIENT_ID, dto);

      expect(result.data.status).toBe(ServiceRequestStatus.OPEN);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SERVICE_REQUEST_CREATED' }),
      );
    });

    it('rejeita não-cliente (PROVIDER)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejeita serviço inexistente', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(service.create(CLIENT_ID, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejeita serviço não-ACTIVE', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.service.findUnique.mockResolvedValue(
        makeService({ status: ServiceStatus.PENDING_REVIEW }),
      );
      await expect(service.create(CLIENT_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita pedido do próprio provider sobre o seu serviço', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: PROVIDER_ID,
        role: UserRole.CLIENT,
      });
      prisma.service.findUnique.mockResolvedValue(
        makeService({ providerId: PROVIDER_ID }),
      );
      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita isUrgent=true se serviço não aceita urgentes', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.service.findUnique.mockResolvedValue(
        makeService({ acceptsUrgent: false }),
      );
      await expect(
        service.create(CLIENT_ID, { ...dto, isUrgent: true }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita expiresAt no passado', async () => {
      prisma.user.findUnique.mockResolvedValue(makeClient());
      prisma.service.findUnique.mockResolvedValue(makeService());
      await expect(
        service.create(CLIENT_ID, {
          ...dto,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne()', () => {
    it('cliente dono acede', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.user.findUnique.mockResolvedValue(makeClient());
      const result = await service.findOne(CLIENT_ID, REQUEST_ID);
      expect(result.data.id).toBe(REQUEST_ID);
    });

    it('provider do serviço acede', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      const result = await service.findOne(PROVIDER_ID, REQUEST_ID);
      expect(result.data.id).toBe(REQUEST_ID);
    });

    it('admin acede', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      const result = await service.findOne(ADMIN_ID, REQUEST_ID);
      expect(result.data.id).toBe(REQUEST_ID);
    });

    it('outro user é proibido', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.user.findUnique.mockResolvedValue({
        id: 'outro',
        role: UserRole.CLIENT,
      });
      await expect(service.findOne('outro', REQUEST_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('findMine()', () => {
    it('devolve pedidos do cliente com paginação', async () => {
      prisma.serviceRequest.findMany.mockResolvedValue([makeRequest()]);
      prisma.serviceRequest.count.mockResolvedValue(1);

      const result = await service.findMine(CLIENT_ID, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.meta?.total).toBe(1);
      const call = prisma.serviceRequest.findMany.mock.calls[0][0] as {
        where: { clientId?: string };
      };
      expect(call.where.clientId).toBe(CLIENT_ID);
    });

    it('aplica filtro de status', async () => {
      prisma.serviceRequest.findMany.mockResolvedValue([]);
      prisma.serviceRequest.count.mockResolvedValue(0);

      await service.findMine(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: ServiceRequestStatus.OPEN,
      });

      const call = prisma.serviceRequest.findMany.mock.calls[0][0] as {
        where: { status?: string };
      };
      expect(call.where.status).toBe(ServiceRequestStatus.OPEN);
    });
  });

  describe('findOne() — branches adicionais', () => {
    it('pedido inexistente -> NotFound', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.findOne(CLIENT_ID, REQUEST_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('user inexistente -> NotFound', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOne(CLIENT_ID, REQUEST_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancel()', () => {
    it('cliente dono cancela OPEN com sucesso', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue({
        id: REQUEST_ID,
        clientId: CLIENT_ID,
        status: ServiceRequestStatus.OPEN,
      });
      prisma.$transaction.mockImplementation(
        async (
          cb: (tx: typeof prisma) => Promise<unknown>,
        ): Promise<unknown> => {
          prisma.serviceRequest.update.mockResolvedValue(
            makeRequest({ status: ServiceRequestStatus.CANCELLED }),
          );
          prisma.serviceQuote.updateMany.mockResolvedValue({ count: 0 });
          return cb(prisma);
        },
      );

      const result = await service.cancel(CLIENT_ID, REQUEST_ID);
      expect(result.data.status).toBe(ServiceRequestStatus.CANCELLED);
      expect(prisma.serviceQuote.updateMany).toHaveBeenCalled();
    });

    it('não-dono não cancela', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue({
        id: REQUEST_ID,
        clientId: CLIENT_ID,
        status: ServiceRequestStatus.OPEN,
      });
      await expect(service.cancel('outro', REQUEST_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('não cancela ACCEPTED', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue({
        id: REQUEST_ID,
        clientId: CLIENT_ID,
        status: ServiceRequestStatus.ACCEPTED,
      });
      await expect(service.cancel(CLIENT_ID, REQUEST_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
