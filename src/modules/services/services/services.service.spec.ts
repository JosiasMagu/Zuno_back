import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CategoryKind,
  Prisma,
  ServicePricingType,
  ServiceStatus,
  UserRole,
} from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { ServiceSortBy } from '../dto/find-services-query.dto';
import { ServicesService } from './services.service';

const PROVIDER_ID = 'provider-uuid';
const CLIENT_ID = 'client-uuid';
const ADMIN_ID = 'admin-uuid';
const SERVICE_ID = 'service-uuid';
const CATEGORY_ID = 'category-uuid';

const makeProvider = () => ({ id: PROVIDER_ID, role: UserRole.PROVIDER });
const makeClient = () => ({ id: CLIENT_ID, role: UserRole.CLIENT });
const makeAdmin = () => ({ id: ADMIN_ID, role: UserRole.ADMIN });

const makeCategory = (overrides: Partial<{ kind: CategoryKind }> = {}) => ({
  id: CATEGORY_ID,
  name: 'Electricidade',
  slug: 'electricidade',
  isActive: true,
  kind: CategoryKind.SERVICE,
  ...overrides,
});

const makeService = (overrides: Record<string, unknown> = {}) => ({
  id: SERVICE_ID,
  providerId: PROVIDER_ID,
  title: 'Reparação eléctrica',
  description: 'Diagnóstico e reparação eléctrica residencial.',
  categoryId: CATEGORY_ID,
  basePrice: new Prisma.Decimal(1500),
  pricingType: ServicePricingType.FIXED,
  estimatedHours: null,
  location: 'Maputo',
  latitude: null,
  longitude: null,
  acceptsUrgent: true,
  urgentSurcharge: new Prisma.Decimal(30),
  status: ServiceStatus.PENDING_REVIEW,
  isActive: true,
  totalRating: null,
  totalReviews: 0,
  totalCompleted: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  category: makeCategory(),
  provider: { id: PROVIDER_ID, name: 'Provider', avatarUrl: null },
  photos: [],
  ...overrides,
});

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  category: { findFirst: jest.fn() },
  service: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
});

describe('ServicesService', () => {
  let service: ServicesService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ServicesService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  describe('create()', () => {
    const dto = {
      title: 'Reparação eléctrica',
      description: 'Diagnóstico e reparação eléctrica.',
      categoryId: CATEGORY_ID,
      basePrice: 1500,
      pricingType: ServicePricingType.FIXED,
      location: 'Maputo',
      acceptsUrgent: true,
      urgentSurcharge: 30,
    };

    it('cria serviço com sucesso em PENDING_REVIEW', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.service.create.mockResolvedValue(makeService());

      const result = await service.create(PROVIDER_ID, dto);

      expect(result.data.status).toBe(ServiceStatus.PENDING_REVIEW);
      expect(prisma.service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerId: PROVIDER_ID,
            status: ServiceStatus.PENDING_REVIEW,
          }),
        }),
      );
    });

    it('rejeita categoria inativa ou inexistente', async () => {
      prisma.category.findFirst.mockResolvedValue(null);
      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita categoria que não serve serviços (kind=EQUIPMENT)', async () => {
      prisma.category.findFirst.mockResolvedValue(
        makeCategory({ kind: CategoryKind.EQUIPMENT }),
      );
      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('aceita categoria com kind=BOTH', async () => {
      prisma.category.findFirst.mockResolvedValue(
        makeCategory({ kind: CategoryKind.BOTH }),
      );
      prisma.service.create.mockResolvedValue(makeService());
      await expect(service.create(PROVIDER_ID, dto)).resolves.toBeDefined();
    });

    it('HOURLY pricing exige estimatedHours', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      await expect(
        service.create(PROVIDER_ID, {
          ...dto,
          pricingType: ServicePricingType.HOURLY,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('acceptsUrgent=true exige urgentSurcharge', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      await expect(
        service.create(PROVIDER_ID, {
          ...dto,
          acceptsUrgent: true,
          urgentSurcharge: undefined,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('acceptsUrgent=false não permite urgentSurcharge', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      await expect(
        service.create(PROVIDER_ID, {
          ...dto,
          acceptsUrgent: false,
          urgentSurcharge: 30,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  describe('findAll()', () => {
    it('filtra apenas serviços ACTIVE e isActive=true', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10 });

      const call = prisma.service.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBe(ServiceStatus.ACTIVE);
      expect(call.where.isActive).toBe(true);
    });

    it('rejeita minPrice > maxPrice', async () => {
      await expect(
        service.findAll({ page: 1, limit: 10, minPrice: 5000, maxPrice: 1000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('aplica filtro de urgência (acceptsUrgent)', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, isUrgent: true });

      const call = prisma.service.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.acceptsUrgent).toBe(true);
    });

    it('ordena por LOWEST_PRICE com basePrice asc', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        sortBy: ServiceSortBy.LOWEST_PRICE,
      });

      const call = prisma.service.findMany.mock.calls[0][0] as {
        orderBy: Array<{ basePrice: string }>;
      };
      expect(call.orderBy[0].basePrice).toBe('asc');
    });
  });

  // -------------------------------------------------------------------------
  describe('findOne()', () => {
    it('devolve serviço ACTIVE', async () => {
      prisma.service.findFirst.mockResolvedValue(
        makeService({ status: ServiceStatus.ACTIVE }),
      );
      const result = await service.findOne(SERVICE_ID);
      expect(result.data.id).toBe(SERVICE_ID);
    });

    it('lança NotFound se serviço não existe ou não está ACTIVE', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.findOne(SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('findMyListings()', () => {
    it('PROVIDER vê apenas os seus', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.service.findMany.mockResolvedValue([]);

      await service.findMyListings(PROVIDER_ID);

      const call = prisma.service.findMany.mock.calls[0][0] as {
        where: { providerId?: string };
      };
      expect(call.where.providerId).toBe(PROVIDER_ID);
    });

    it('ADMIN vê todos (sem filtro)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findMany.mockResolvedValue([]);

      await service.findMyListings(ADMIN_ID);

      const call = prisma.service.findMany.mock.calls[0][0] as {
        where: { providerId?: string };
      };
      expect(call.where.providerId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('approve() / reject()', () => {
    it('approve rejeita se não-admin', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      await expect(service.approve(PROVIDER_ID, SERVICE_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('approve transita PENDING_REVIEW -> ACTIVE', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.PENDING_REVIEW,
      });
      prisma.service.update.mockResolvedValue(
        makeService({ status: ServiceStatus.ACTIVE }),
      );

      await service.approve(ADMIN_ID, SERVICE_ID);

      expect(prisma.service.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ServiceStatus.ACTIVE, isActive: true },
        }),
      );
    });

    it('approve recusa serviço já ACTIVE', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.ACTIVE,
      });
      await expect(service.approve(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('approve recusa serviço DELETED', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.DELETED,
      });
      await expect(service.approve(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reject muda para REJECTED com motivo', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.PENDING_REVIEW,
      });
      prisma.service.update.mockResolvedValue(
        makeService({ status: ServiceStatus.REJECTED }),
      );

      const result = await service.reject(ADMIN_ID, SERVICE_ID, 'Sem fotos.');
      expect(result.message).toContain('Sem fotos');
      expect(prisma.service.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ServiceStatus.REJECTED, isActive: false },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('toggleAvailability()', () => {
    it('PROVIDER alterna o seu próprio', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: ServiceStatus.ACTIVE,
        isActive: true,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.service.update.mockResolvedValue(makeService({ isActive: false }));

      const result = await service.toggleAvailability(PROVIDER_ID, SERVICE_ID);
      expect(result.message).toContain('indisponível');
    });

    it('rejeita user que não é dono nem admin', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: ServiceStatus.ACTIVE,
        isActive: true,
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(
        service.toggleAvailability(CLIENT_ID, SERVICE_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('só ACTIVE pode alternar', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: ServiceStatus.PENDING_REVIEW,
        isActive: true,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());

      await expect(
        service.toggleAvailability(PROVIDER_ID, SERVICE_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findPending() / findOne() — branches adicionais', () => {
    it('findPending exige ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      await expect(service.findPending(PROVIDER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('findPending devolve serviços PENDING_REVIEW', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findMany.mockResolvedValue([makeService()]);
      const result = await service.findPending(ADMIN_ID);
      expect(result.data).toHaveLength(1);
    });

    it('findMyListings: user inexistente -> NotFound', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findMyListings('x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('approve/reject — branches adicionais', () => {
    it('approve: serviço inexistente -> NotFound', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(service.approve(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reject: já REJECTED -> BadRequest', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.REJECTED,
      });
      await expect(service.reject(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reject: serviço inexistente -> NotFound', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(service.reject(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reject: serviço DELETED -> BadRequest', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.DELETED,
      });
      await expect(service.reject(ADMIN_ID, SERVICE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('toggleAvailability: serviço inexistente -> NotFound', async () => {
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(
        service.toggleAvailability(PROVIDER_ID, SERVICE_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('toggleAvailability: user inexistente -> NotFound', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: ServiceStatus.ACTIVE,
        isActive: true,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.toggleAvailability('x', SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('remove() — soft delete', () => {
    it('PROVIDER faz soft delete do seu', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.service.update.mockResolvedValue({});

      const result = await service.remove(PROVIDER_ID, SERVICE_ID);
      expect(result.message).toBe('Serviço removido com sucesso.');
      expect(prisma.service.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ServiceStatus.DELETED, isActive: false },
        }),
      );
    });

    it('rejeita não-dono não-admin', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(service.remove(CLIENT_ID, SERVICE_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('remove: serviço inexistente -> NotFound', async () => {
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(service.remove(PROVIDER_ID, SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('remove: user inexistente -> NotFound', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.remove('x', SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('ADMIN pode remover qualquer serviço', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.update.mockResolvedValue({});
      const result = await service.remove(ADMIN_ID, SERVICE_ID);
      expect(result.message).toBe('Serviço removido com sucesso.');
    });
  });

  // -------------------------------------------------------------------------
  describe('update()', () => {
    it('PROVIDER actualiza o seu', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: true,
        urgentSurcharge: new Prisma.Decimal(30),
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.service.update.mockResolvedValue(makeService({ title: 'Novo' }));

      await service.update(PROVIDER_ID, SERVICE_ID, { title: 'Novo' });
      expect(prisma.service.update).toHaveBeenCalled();
    });

    it('rejeita acceptsUrgent=true sem urgentSurcharge', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: false,
        urgentSurcharge: null,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());

      await expect(
        service.update(PROVIDER_ID, SERVICE_ID, { acceptsUrgent: true }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita user não-autenticado em update', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: false,
        urgentSurcharge: null,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.update('inexistente', SERVICE_ID, { title: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejeita serviço inexistente em update', async () => {
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(
        service.update(PROVIDER_ID, SERVICE_ID, { title: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejeita não-dono não-admin em update', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: false,
        urgentSurcharge: null,
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());
      await expect(
        service.update(CLIENT_ID, SERVICE_ID, { title: 'X' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('update: nova categoria tem de servir serviços', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: false,
        urgentSurcharge: null,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.category.findFirst.mockResolvedValue(
        makeCategory({ kind: CategoryKind.EQUIPMENT }),
      );

      await expect(
        service.update(PROVIDER_ID, SERVICE_ID, { categoryId: 'nova-cat' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('passar acceptsUrgent=false anula urgentSurcharge', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        acceptsUrgent: true,
        urgentSurcharge: new Prisma.Decimal(30),
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.service.update.mockResolvedValue(
        makeService({ acceptsUrgent: false, urgentSurcharge: null }),
      );

      await service.update(PROVIDER_ID, SERVICE_ID, { acceptsUrgent: false });

      const call = prisma.service.update.mock.calls[0][0] as {
        data: { urgentSurcharge?: unknown };
      };
      expect(call.data.urgentSurcharge).toBeNull();
    });
  });
});
