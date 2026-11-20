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

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
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

const makePrisma = () => {
  const mock = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    category: { findFirst: jest.fn() },
    service: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    // Por omissão o serviço não tem reservas em curso.
    serviceBooking: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };

  // As transacções correm sobre o próprio mock.
  mock.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
    work(mock),
  );

  return mock;
};

describe('ServicesService', () => {
  let service: ServicesService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: PushService,
          useValue: { send: jest.fn().mockResolvedValue(undefined) },
        },
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

    it('promove a PROVIDER a conta CLIENT que publica um serviço', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.CLIENT,
        listingsSuspendedUntil: null,
      });
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.service.create.mockResolvedValue(makeService());

      await service.create(PROVIDER_ID, dto);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: PROVIDER_ID },
        data: { role: UserRole.PROVIDER },
      });
    });

    it.each([UserRole.PROVIDER, UserRole.ADMIN])(
      'não mexe no papel de uma conta %s',
      async (role) => {
        prisma.user.findUnique.mockResolvedValue({
          role,
          listingsSuspendedUntil: null,
        });
        prisma.category.findFirst.mockResolvedValue(makeCategory());
        prisma.service.create.mockResolvedValue(makeService());

        await service.create(PROVIDER_ID, dto);

        expect(prisma.user.update).not.toHaveBeenCalled();
      },
    );

    it('não promove ninguém quando a categoria é recusada', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.CLIENT,
        listingsSuspendedUntil: null,
      });
      prisma.category.findFirst.mockResolvedValue(null);

      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
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

    describe('anúncio fora do catálogo, pedido com sessão', () => {
      beforeEach(() => {
        // O detalhe público não o encontra: não está activo.
        prisma.service.findFirst.mockResolvedValue(null);
        prisma.service.findUnique.mockResolvedValue(
          makeService({ status: ServiceStatus.PENDING_REVIEW }),
        );
      });

      it('responde ao provider como em findMine', async () => {
        prisma.user.findUnique.mockResolvedValue(makeProvider());

        const result = await service.findOne(SERVICE_ID, PROVIDER_ID);

        expect(result.data).toMatchObject({
          id: SERVICE_ID,
          status: ServiceStatus.PENDING_REVIEW,
        });
      });

      it('responde a um admin', async () => {
        prisma.user.findUnique.mockResolvedValue(makeAdmin());

        const result = await service.findOne(SERVICE_ID, ADMIN_ID);

        expect(result.data.status).toBe(ServiceStatus.PENDING_REVIEW);
      });

      it('responde 404 a outra conta, sem dizer que o anúncio existe', async () => {
        prisma.user.findUnique.mockResolvedValue(makeClient());

        await expect(service.findOne(SERVICE_ID, CLIENT_ID)).rejects.toThrow(
          new NotFoundException('Serviço não encontrado.'),
        );
      });
    });

    it('sem sessão não procura fora do catálogo', async () => {
      prisma.service.findFirst.mockResolvedValue(null);

      await expect(service.findOne(SERVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.service.findUnique).not.toHaveBeenCalled();
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
          data: {
            status: ServiceStatus.ACTIVE,
            isActive: true,
            rejectionReason: null,
            rejectedAt: null,
          },
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
          data: {
            status: ServiceStatus.REJECTED,
            isActive: false,
            // O motivo fica no anúncio, para o provider o corrigir.
            rejectionReason: 'Sem fotos.',
            rejectedAt: expect.any(Date) as Date,
          },
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

    it('findPending traz a data de criação, que o painel de admin mostra', async () => {
      const createdAt = new Date('2026-11-20T08:00:00Z');
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findMany.mockResolvedValue([makeService({ createdAt })]);

      const result = await service.findPending(ADMIN_ID);

      expect(result.data[0].createdAt).toEqual(createdAt);
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

  // Moderação: o que volta à revisão e o que continua público

  describe('moderação das edições', () => {
    const asProvider = () =>
      prisma.user.findUnique.mockResolvedValue({
        id: PROVIDER_ID,
        role: UserRole.PROVIDER,
      });

    /** Um anúncio já aprovado, salvo indicação em contrário. */
    const editing = (overrides: Record<string, unknown> = {}) => {
      const listing = makeService({
        status: ServiceStatus.ACTIVE,
        ...overrides,
      });
      prisma.service.findUnique.mockResolvedValue(listing);
      prisma.service.update.mockResolvedValue(listing);
    };

    const updateData = () =>
      (
        prisma.service.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;

    it('fica activo quando só muda o preço', async () => {
      asProvider();
      editing();
      const current = makeService();

      const result = await service.update(PROVIDER_ID, SERVICE_ID, {
        title: current.title,
        description: current.description,
        basePrice: 9999,
      });

      expect(updateData().status).toBeUndefined();
      expect(result.message).toBe('Serviço atualizado com sucesso.');
    });

    it('volta à revisão quando o provider muda a descrição', async () => {
      asProvider();
      editing();

      const result = await service.update(PROVIDER_ID, SERVICE_ID, {
        description: 'Agora também vendo material eléctrico ao balcão.',
      });

      expect(updateData().status).toBe(ServiceStatus.PENDING_REVIEW);
      expect(result.message).toContain('volta à revisão');
    });

    it('fica activo quando é um admin a editar', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      editing();

      await service.update(ADMIN_ID, SERVICE_ID, { title: 'Outro título' });

      expect(updateData().status).toBeUndefined();
    });

    it('um anúncio rejeitado volta à revisão com qualquer mudança', async () => {
      asProvider();
      editing({ status: ServiceStatus.REJECTED });

      const result = await service.update(PROVIDER_ID, SERVICE_ID, {
        basePrice: 9999,
      });

      expect(updateData().status).toBe(ServiceStatus.PENDING_REVIEW);
      expect(result.message).toContain('enviado de novo para revisão');
    });

    it('responde 404 a um anúncio removido', async () => {
      asProvider();
      editing({ status: ServiceStatus.DELETED });

      await expect(
        service.update(PROVIDER_ID, SERVICE_ID, { title: 'Outro título' }),
      ).rejects.toThrow(new NotFoundException('Serviço não encontrado.'));
    });

    it('uma foto nova devolve um anúncio activo à revisão', async () => {
      const backToReview = await service.reviewAfterPhotoChange({
        actorId: PROVIDER_ID,
        actorRole: UserRole.PROVIDER,
        service: { id: SERVICE_ID, status: ServiceStatus.ACTIVE },
        addedPhotos: true,
      });

      expect(backToReview).toBe(true);
      expect(prisma.service.update).toHaveBeenCalledWith({
        where: { id: SERVICE_ID },
        data: { status: ServiceStatus.PENDING_REVIEW },
      });
    });
  });

  describe('catálogo, aprovação e remoção', () => {
    it('a listagem pública deixa de fora os anúncios de contas suspensas', async () => {
      prisma.service.findMany.mockResolvedValue([]);

      await service.findAll({ page: 1, limit: 10 });

      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            provider: { isActive: true },
          }) as object,
        }),
      );
    });

    it('a aprovação não desfaz uma suspensão por strikes: o anúncio fica pausado', async () => {
      prisma.user.findUnique.mockResolvedValue(makeAdmin());
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        status: ServiceStatus.PENDING_REVIEW,
        provider: {
          listingsSuspendedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      prisma.service.update.mockResolvedValue(makeService());

      await service.approve(ADMIN_ID, SERVICE_ID);

      expect(prisma.service.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ServiceStatus.ACTIVE,
            isActive: false,
          }) as object,
        }),
      );
    });

    it('os meus anúncios vêm paginados e sem os removidos', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: PROVIDER_ID,
        role: UserRole.PROVIDER,
      });
      prisma.service.findMany.mockResolvedValue([makeService()]);
      prisma.service.count.mockResolvedValue(1);

      const result = await service.findMyListings(PROVIDER_ID);

      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            providerId: PROVIDER_ID,
            status: { not: ServiceStatus.DELETED },
          },
          skip: 0,
          take: 50,
        }),
      );
      expect(result.meta).toMatchObject({ page: 1, limit: 50, total: 1 });
    });

    it('recusa remover um serviço com reservas em curso', async () => {
      prisma.service.findUnique.mockResolvedValue(makeService());
      prisma.user.findUnique.mockResolvedValue({
        id: PROVIDER_ID,
        role: UserRole.PROVIDER,
      });
      prisma.serviceBooking.count.mockResolvedValue(2);

      await expect(service.remove(PROVIDER_ID, SERVICE_ID)).rejects.toThrow(
        new BadRequestException(
          'Este serviço tem reservas em curso. Pausa o anúncio para não receber mais pedidos e remove-o quando elas terminarem.',
        ),
      );
      expect(prisma.service.update).not.toHaveBeenCalled();
    });
  });
});
