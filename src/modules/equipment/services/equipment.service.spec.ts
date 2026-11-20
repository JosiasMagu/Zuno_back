import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditAction,
  BookingStatus,
  EquipmentCondition,
  EquipmentStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { PushService } from '../../../shared/push/push.service';
import { VerificationsService } from '../../verifications/services/verifications.service';
import { EquipmentSortBy } from '../dto/find-equipment-query.dto';
import { EquipmentAvailabilityService } from './equipment-availability.service';
import { EquipmentService } from './equipment.service';

// CONSTANTES

const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const CATEGORY_ID = 'category-uuid-001';

// FACTORIES

const makeUser = (id: string, role: UserRole) => ({
  id,
  role,
  name: role,
  phone: '+258840000000',
  email: null,
  passwordHash: 'hash',
  isVerified: true,
  isActive: true,
  avatarUrl: null,
  bio: null,
  totalRating: null,
  totalReviews: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeCategory = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: CATEGORY_ID,
  name: 'Construção',
  slug: 'construcao',
  description: null,
  icon: null,
  kind: 'EQUIPMENT',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeEquipment = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: EQUIPMENT_ID,
  ownerId: OWNER_ID,
  title: 'Betoneira 300L',
  description: 'Betoneira em bom estado',
  categoryId: CATEGORY_ID,
  pricePerDay: new Prisma.Decimal(500),
  pricePerWeek: null,
  pricePerMonth: null,
  depositAmount: new Prisma.Decimal(1000),
  location: 'Maputo',
  latitude: null,
  longitude: null,
  deliveryIncluded: false,
  operatorAvailable: false,
  isAvailable: true,
  quantity: 1,
  condition: EquipmentCondition.GOOD,
  status: EquipmentStatus.ACTIVE,
  isPremium: false,
  totalRating: null,
  totalReviews: 0,
  totalBookings: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  category: { id: CATEGORY_ID, name: 'Construção', slug: 'construcao' },
  photos: [],
  ...overrides,
});

// MOCK DO PRISMA

const makePrismaMock = () => {
  const mock = {
    equipment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    category: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    // Por omissão o equipamento não tem reservas em curso.
    booking: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    payment: {
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  // As transacções correm sobre o próprio mock.
  mock.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
    work(mock),
  );

  return mock;
};

// Por omissão nenhuma reserva ocupa nada: todas as unidades estão livres.
const makeAvailabilityMock = () => ({
  freeUnitsToday: jest.fn((items: Array<{ id: string; quantity: number }>) =>
    Promise.resolve(new Map(items.map((item) => [item.id, item.quantity]))),
  ),
  findFullyBookedIds: jest.fn().mockResolvedValue([]),
});

// SUITE PRINCIPAL

describe('EquipmentService', () => {
  let service: EquipmentService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let availability: ReturnType<typeof makeAvailabilityMock>;
  let audit: { record: jest.Mock };
  let push: { send: jest.Mock };
  let verifications: { isVerified: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    availability = makeAvailabilityMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: VerificationsService,
          useValue: { isVerified: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: PushService,
          useValue: { send: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: MetricsService,
          useValue: { businessEvents: { inc: jest.fn() } },
        },
        { provide: EquipmentAvailabilityService, useValue: availability },
      ],
    }).compile();

    service = module.get<EquipmentService>(EquipmentService);
    audit = module.get(AuditService);
    push = module.get(PushService);
    verifications = module.get(VerificationsService);
  });

  afterEach(() => jest.clearAllMocks());

  // create()

  describe('create()', () => {
    const validDto = {
      categoryId: CATEGORY_ID,
      title: 'Betoneira 300L',
      description: 'Betoneira em bom estado',
      pricePerDay: 500,
      depositAmount: 1000,
      location: 'Maputo',
      condition: EquipmentCondition.GOOD,
      deliveryAvailable: false,
      operatorAvailable: false,
    };

    it('cria equipamento com sucesso e devolve status PENDING_REVIEW', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW }),
      );

      const result = await service.create(OWNER_ID, validDto);

      expect(result.message).toContain('Aguarda aprovação do administrador.');
      expect(result.data.id).toBe(EQUIPMENT_ID);
    });

    it('cria sempre com status PENDING_REVIEW — nunca ACTIVE directamente', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW }),
      );

      await service.create(OWNER_ID, validDto);

      const createCall = prisma.equipment.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.status).toBe(EquipmentStatus.PENDING_REVIEW);
    });

    it('lança BadRequestException se categoria não existe ou está inativa', async () => {
      prisma.category.findFirst.mockResolvedValue(null);

      await expect(service.create(OWNER_ID, validDto)).rejects.toThrow(
        new BadRequestException('Categoria não encontrada ou inativa.'),
      );
      expect(prisma.equipment.create).not.toHaveBeenCalled();
    });

    it('faz trim no title, description e location', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(makeEquipment());

      await service.create(OWNER_ID, {
        ...validDto,
        title: '  Betoneira  ',
        description: '  Boa condição  ',
        location: '  Maputo Centro  ',
      });

      const createCall = prisma.equipment.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.title).toBe('Betoneira');
      expect(createCall.data.description).toBe('Boa condição');
      expect(createCall.data.location).toBe('Maputo Centro');
    });

    it('usa EquipmentCondition.GOOD como default se condition não fornecido', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(makeEquipment());

      const dtoSemCondition = {
        categoryId: CATEGORY_ID,
        title: 'Betoneira 300L',
        description: 'Betoneira em bom estado',
        pricePerDay: 500,
        depositAmount: 1000,
        location: 'Maputo',
        deliveryAvailable: false,
        operatorAvailable: false,
      };

      await service.create(OWNER_ID, dtoSemCondition as typeof validDto);

      const createCall = prisma.equipment.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.condition).toBe(EquipmentCondition.GOOD);
    });

    it('usa false como default para deliveryAvailable e operatorAvailable', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(makeEquipment());

      const dtoMinimo = {
        categoryId: CATEGORY_ID,
        title: 'X',
        description: 'X',
        pricePerDay: 100,
        depositAmount: 0,
        location: 'Maputo',
      };

      await service.create(OWNER_ID, dtoMinimo as typeof validDto);

      const createCall = prisma.equipment.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.deliveryIncluded).toBe(false);
      expect(createCall.data.operatorAvailable).toBe(false);
    });

    it('associa o ownerId correctamente', async () => {
      prisma.category.findFirst.mockResolvedValue(makeCategory());
      prisma.equipment.create.mockResolvedValue(makeEquipment());

      await service.create(OWNER_ID, validDto);

      const createCall = prisma.equipment.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.ownerId).toBe(OWNER_ID);
    });
  });

  // findAll()

  describe('findAll()', () => {
    it('filtra apenas equipamentos ACTIVE', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10 });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ status: EquipmentStatus.ACTIVE });
    });

    describe('disponibilidade', () => {
      const whereOfFindMany = () =>
        (
          prisma.equipment.findMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
          }
        ).where;

      beforeEach(() => {
        prisma.equipment.findMany.mockResolvedValue([]);
        prisma.equipment.count.mockResolvedValue(0);
      });

      it('devolve em availableQuantity as unidades livres hoje', async () => {
        prisma.equipment.findMany.mockResolvedValue([
          makeEquipment({ quantity: 3 }),
        ]);
        availability.freeUnitsToday.mockResolvedValue(
          new Map([[EQUIPMENT_ID, 1]]),
        );

        const result = await service.findAll({ page: 1, limit: 10 });

        expect(result.data[0]).toMatchObject({
          quantity: 3,
          availableQuantity: 1,
        });
      });

      it('sem filtros de disponibilidade não tira nenhum equipamento', async () => {
        await service.findAll({ page: 1, limit: 10 });

        expect(availability.findFullyBookedIds).not.toHaveBeenCalled();
        expect(whereOfFindMany()).not.toHaveProperty('id');
      });

      it('com onlyAvailableNow tira os pausados e os que não têm unidade livre hoje', async () => {
        availability.findFullyBookedIds.mockResolvedValue(['eq-sem-unidades']);

        await service.findAll({ page: 1, limit: 10, onlyAvailableNow: true });

        expect(whereOfFindMany()).toMatchObject({
          isAvailable: true,
          id: { notIn: ['eq-sem-unidades'] },
        });
      });

      it('com datas tira os equipamentos sem unidade livre nesse período', async () => {
        availability.findFullyBookedIds.mockResolvedValue(['eq-sem-unidades']);

        await service.findAll({
          page: 1,
          limit: 10,
          availableFrom: '2030-06-01T15:30:00+02:00',
          availableTo: '2030-06-05T09:00:00+02:00',
        });

        // Em dias inteiros de Maputo, como as reservas: a hora pedida não
        // conta, e o resultado não depende do fuso da máquina.
        expect(availability.findFullyBookedIds).toHaveBeenCalledWith({
          startDate: new Date('2030-05-31T22:00:00.000Z'),
          endDate: new Date('2030-06-04T22:00:00.000Z'),
        });
        expect(whereOfFindMany()).toMatchObject({
          id: { notIn: ['eq-sem-unidades'] },
        });
      });

      it('recusa uma só das duas datas do período', async () => {
        await expect(
          service.findAll({ page: 1, limit: 10, availableFrom: '2030-06-01' }),
        ).rejects.toThrow(
          new BadRequestException(
            'availableFrom e availableTo devem ser fornecidos juntos.',
          ),
        );
      });

      it('recusa um período que começa e acaba no mesmo dia', async () => {
        await expect(
          service.findAll({
            page: 1,
            limit: 10,
            availableFrom: '2030-06-01T08:00:00',
            availableTo: '2030-06-01T18:00:00',
          }),
        ).rejects.toThrow(
          new BadRequestException(
            'availableTo deve ser posterior a availableFrom.',
          ),
        );
      });

      it('recusa um período que acaba antes de começar', async () => {
        await expect(
          service.findAll({
            page: 1,
            limit: 10,
            availableFrom: '2030-06-05',
            availableTo: '2030-06-01',
          }),
        ).rejects.toThrow(
          new BadRequestException(
            'availableTo deve ser posterior a availableFrom.',
          ),
        );
      });
    });

    it('lança BadRequestException se minPrice > maxPrice', async () => {
      await expect(
        service.findAll({ page: 1, limit: 10, minPrice: 1000, maxPrice: 500 }),
      ).rejects.toThrow(
        new BadRequestException(
          'O preço mínimo não pode ser maior que o preço máximo.',
        ),
      );
      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
    });

    it('aplica filtro de search (title, description, location, category)', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, search: 'betoneira' });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toHaveProperty('OR');
      const orArray = whereArg.OR as Array<Record<string, unknown>>;
      expect(orArray.length).toBeGreaterThan(0);
    });

    it('não aplica filtro de search se string vazia após trim', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, search: '   ' });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).not.toHaveProperty('OR');
    });

    it('filtra pela categoria pedida e pelas que estão debaixo dela', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);
      prisma.category.findMany.mockResolvedValue([
        { id: CATEGORY_ID, slug: 'construcao', parentId: null },
        { id: 'betoneiras', slug: 'betoneiras', parentId: CATEGORY_ID },
        { id: 'jardinagem', slug: 'jardinagem', parentId: null },
      ]);

      await service.findAll({ page: 1, limit: 10, categoryId: CATEGORY_ID });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({
        categoryId: { in: [CATEGORY_ID, 'betoneiras'] },
      });
    });

    it('não devolve nada quando a categoria pedida não existe ou está desactivada', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, categoryId: CATEGORY_ID });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ categoryId: { in: [] } });
    });

    it('filtra por location quando fornecido', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, location: 'Maputo' });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toHaveProperty('location');
    });

    it('filtra por deliveryAvailable quando fornecido', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, deliveryAvailable: true });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ deliveryIncluded: true });
    });

    describe('deliveryIncluded, o nome antigo do filtro de entrega', () => {
      const deliveryFilterOf = async (query: {
        deliveryAvailable?: boolean;
        deliveryIncluded?: boolean;
      }) => {
        prisma.equipment.findMany.mockResolvedValue([]);

        await service.findAll({ page: 1, limit: 10, ...query });

        const { where } = prisma.equipment.findMany.mock.calls[0][0] as {
          where: { deliveryIncluded?: boolean };
        };
        return where.deliveryIncluded;
      };

      it('filtra como deliveryAvailable', async () => {
        expect(await deliveryFilterOf({ deliveryIncluded: true })).toBe(true);
      });

      it('aceita false, que pede os anúncios sem entrega', async () => {
        expect(await deliveryFilterOf({ deliveryIncluded: false })).toBe(false);
      });

      it('perde para deliveryAvailable quando chegam os dois', async () => {
        expect(
          await deliveryFilterOf({
            deliveryAvailable: false,
            deliveryIncluded: true,
          }),
        ).toBe(false);
      });

      it('não filtra quando não chega nenhum', async () => {
        expect(await deliveryFilterOf({})).toBeUndefined();
      });
    });

    it('filtra por condition quando fornecido', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        condition: EquipmentCondition.NEW,
      });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ condition: EquipmentCondition.NEW });
    });

    it('aplica filtro de preço com gte e lte', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        minPrice: 200,
        maxPrice: 800,
      });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toHaveProperty('pricePerDay');
      const price = whereArg.pricePerDay as Record<string, number>;
      expect(price.gte).toBe(200);
      expect(price.lte).toBe(800);
    });

    it('devolve paginação correcta', async () => {
      prisma.equipment.findMany.mockResolvedValue([makeEquipment()]);
      prisma.equipment.count.mockResolvedValue(25);

      const result = await service.findAll({ page: 2, limit: 10 });

      expect(result.meta).toMatchObject({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('repete a paginação no topo da resposta, onde a app ainda a lê', async () => {
      prisma.equipment.findMany.mockResolvedValue([makeEquipment()]);
      prisma.equipment.count.mockResolvedValue(25);

      const result = await service.findAll({ page: 2, limit: 10 });

      expect(result).toMatchObject({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });

    it('ordena por LOWEST_PRICE quando sortBy=LOWEST_PRICE', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        sortBy: EquipmentSortBy.LOWEST_PRICE,
      });

      const orderByArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          orderBy: unknown[];
        }
      ).orderBy;
      expect(orderByArg[0]).toMatchObject({ pricePerDay: 'asc' });
    });

    it('ordena por HIGHEST_PRICE quando sortBy=HIGHEST_PRICE', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        sortBy: EquipmentSortBy.HIGHEST_PRICE,
      });

      const orderByArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          orderBy: unknown[];
        }
      ).orderBy;
      expect(orderByArg[0]).toMatchObject({ pricePerDay: 'desc' });
    });

    it('ordena por createdAt desc por defeito', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10 });

      const orderByArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          orderBy: unknown[];
        }
      ).orderBy;
      expect(orderByArg[0]).toMatchObject({ createdAt: 'desc' });
    });

    it('ordena por RELEVANT pelos destacados, pelos mais avaliados e pela nota', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({
        page: 1,
        limit: 10,
        sortBy: EquipmentSortBy.RELEVANT,
      });

      const orderByArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          orderBy: unknown[];
        }
      ).orderBy;
      expect(orderByArg[0]).toMatchObject({ isPremium: 'desc' });
      expect(orderByArg[1]).toMatchObject({ totalReviews: 'desc' });
      expect(orderByArg[2]).toMatchObject({
        totalRating: { sort: 'desc', nulls: 'last' },
      });
    });
  });

  // findOne()

  describe('findOne()', () => {
    it('devolve equipamento ACTIVE com sucesso', async () => {
      prisma.equipment.findFirst.mockResolvedValue(makeEquipment());

      const result = await service.findOne(EQUIPMENT_ID);
      expect(result.data.id).toBe(EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento obtido com sucesso.');
    });

    it('lança NotFoundException se equipamento não existe ou não está ACTIVE', async () => {
      prisma.equipment.findFirst.mockResolvedValue(null);

      await expect(service.findOne(EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('filtra por status ACTIVE na query', async () => {
      prisma.equipment.findFirst.mockResolvedValue(makeEquipment());

      await service.findOne(EQUIPMENT_ID);

      const whereArg = (
        prisma.equipment.findFirst.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.ACTIVE,
      });
    });

    describe('anúncio fora do catálogo, pedido com sessão', () => {
      const underReview = () =>
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW });

      beforeEach(() => {
        // O detalhe público não o encontra: não está activo.
        prisma.equipment.findFirst.mockResolvedValue(null);
        prisma.equipment.findUnique.mockResolvedValue(underReview());
      });

      it('responde ao dono como em findMine', async () => {
        prisma.user.findUnique.mockResolvedValue(
          makeUser(OWNER_ID, UserRole.PROVIDER),
        );

        const result = await service.findOne(EQUIPMENT_ID, OWNER_ID);

        expect(result.data).toMatchObject({
          id: EQUIPMENT_ID,
          status: EquipmentStatus.PENDING_REVIEW,
          rejectionReason: null,
        });
      });

      it('responde a um admin', async () => {
        prisma.user.findUnique.mockResolvedValue(
          makeUser(ADMIN_ID, UserRole.ADMIN),
        );

        const result = await service.findOne(EQUIPMENT_ID, ADMIN_ID);

        expect(result.data.status).toBe(EquipmentStatus.PENDING_REVIEW);
      });

      it('responde 404 a outra conta, sem dizer que o anúncio existe', async () => {
        prisma.user.findUnique.mockResolvedValue(
          makeUser(STRANGER_ID, UserRole.CLIENT),
        );

        await expect(
          service.findOne(EQUIPMENT_ID, STRANGER_ID),
        ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
      });

      it('responde 404 ao dono quando o anúncio foi removido', async () => {
        prisma.equipment.findUnique.mockResolvedValue(
          makeEquipment({ status: EquipmentStatus.DELETED }),
        );

        await expect(service.findOne(EQUIPMENT_ID, OWNER_ID)).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    it('sem sessão não procura fora do catálogo', async () => {
      prisma.equipment.findFirst.mockResolvedValue(null);

      await expect(service.findOne(EQUIPMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });

    it('um anúncio activo responde ao dono como a toda a gente', async () => {
      prisma.equipment.findFirst.mockResolvedValue(makeEquipment());

      const result = await service.findOne(EQUIPMENT_ID, OWNER_ID);

      expect(result.data).not.toHaveProperty('rejectionReason');
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });
  });

  // findMyListings()

  describe('findMyListings()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findMyListings(OWNER_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('OWNER vê apenas os seus equipamentos (filtra por ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.findMany.mockResolvedValue([makeEquipment()]);

      await service.findMyListings(OWNER_ID);

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ ownerId: OWNER_ID });
    });

    it('ADMIN vê todos os equipamentos (sem filtro ownerId, excluindo DELETED)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findMany.mockResolvedValue([makeEquipment()]);

      await service.findMyListings(ADMIN_ID);

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toEqual({
        status: { not: EquipmentStatus.DELETED },
      });
      expect(whereArg).not.toHaveProperty('ownerId');
    });

    it('devolve mensagem correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.findMany.mockResolvedValue([]);

      const result = await service.findMyListings(OWNER_ID);
      expect(result.message).toBe('Equipamentos obtidos com sucesso.');
    });
  });

  // approve()

  describe('approve()', () => {
    it('ADMIN aprova equipamento PENDING_REVIEW com sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.ACTIVE }),
      );

      const result = await service.approve(ADMIN_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento aprovado com sucesso.');
    });

    it('define status ACTIVE e isAvailable=true na aprovação', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.approve(ADMIN_ID, EQUIPMENT_ID);

      const updateCall = prisma.equipment.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).toMatchObject({
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
    });

    it('CLIENT recebe ForbiddenException — não pode aprovar', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(service.approve(STRANGER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para executar esta operação.',
        ),
      );
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });

    it('OWNER recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.approve(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('utilizador inexistente recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.approve('fantasma', EQUIPMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(service.approve(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('lança BadRequestException se equipamento já está ACTIVE', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.ACTIVE,
      });

      await expect(service.approve(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new BadRequestException('Este equipamento já está activo.'),
      );
    });

    it('lança BadRequestException se equipamento está DELETED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.DELETED,
      });

      await expect(service.approve(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível aprovar um equipamento removido.',
        ),
      );
    });

    it('pode aprovar equipamento REJECTED (reactivação)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.REJECTED,
      });
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.ACTIVE }),
      );

      const result = await service.approve(ADMIN_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento aprovado com sucesso.');
    });
  });

  // reject()

  describe('reject()', () => {
    it('ADMIN rejeita equipamento com sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.REJECTED }),
      );

      const result = await service.reject(ADMIN_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento rejeitado.');
    });

    it('inclui motivo na mensagem quando reason é fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.REJECTED }),
      );

      const result = await service.reject(
        ADMIN_ID,
        EQUIPMENT_ID,
        'Fotos insuficientes.',
      );
      expect(result.message).toBe(
        'Equipamento rejeitado. Motivo: Fotos insuficientes.',
      );
    });

    it('define status REJECTED e isAvailable=false na rejeição', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.reject(ADMIN_ID, EQUIPMENT_ID);

      const updateCall = prisma.equipment.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).toMatchObject({
        status: EquipmentStatus.REJECTED,
        isAvailable: false,
      });
    });

    it('CLIENT recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(service.reject(STRANGER_ID, EQUIPMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(service.reject(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('lança BadRequestException se equipamento já está REJECTED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.REJECTED,
      });

      await expect(service.reject(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new BadRequestException('Este equipamento já foi rejeitado.'),
      );
    });

    it('lança BadRequestException se equipamento está DELETED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.DELETED,
      });

      await expect(service.reject(ADMIN_ID, EQUIPMENT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível rejeitar um equipamento removido.',
        ),
      );
    });
  });

  // toggleAvailability()

  describe('toggleAvailability()', () => {
    it('OWNER alterna disponibilidade de true para false', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ isAvailable: false }),
      );

      const result = await service.toggleAvailability(OWNER_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento marcado como indisponível.');
    });

    it('OWNER alterna disponibilidade de false para true', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: false,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ isAvailable: true }),
      );

      const result = await service.toggleAvailability(OWNER_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento marcado como disponível.');
    });

    it('ADMIN pode alterar disponibilidade de qualquer equipamento', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ isAvailable: false }),
      );

      const result = await service.toggleAvailability(ADMIN_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento marcado como indisponível.');
    });

    it('terceiro sem relação recebe ForbiddenException', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(
        service.toggleAvailability(STRANGER_ID, EQUIPMENT_ID),
      ).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para alterar este equipamento.',
        ),
      );
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.toggleAvailability(OWNER_ID, EQUIPMENT_ID),
      ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.toggleAvailability(OWNER_ID, EQUIPMENT_ID),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('lança BadRequestException se equipamento não está ACTIVE', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.PAUSED,
        isAvailable: false,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(
        service.toggleAvailability(OWNER_ID, EQUIPMENT_ID),
      ).rejects.toThrow(
        new BadRequestException(
          'Apenas equipamentos activos podem ter a disponibilidade alterada.',
        ),
      );
    });

    it('inverte o valor actual de isAvailable no update', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({ isAvailable: false }),
      );

      await service.toggleAvailability(OWNER_ID, EQUIPMENT_ID);

      const updateCall = prisma.equipment.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      // isAvailable era true → update deve ser false
      expect(updateCall.data.isAvailable).toBe(false);
    });
  });

  // update()

  describe('update()', () => {
    const validDto = { title: 'Novo título', location: 'Beira' };

    it('OWNER actualiza o seu equipamento com sucesso', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      const result = await service.update(OWNER_ID, EQUIPMENT_ID, validDto);
      expect(result.message).toBe('Equipamento atualizado com sucesso.');
    });

    it('ADMIN actualiza qualquer equipamento', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      const result = await service.update(ADMIN_ID, EQUIPMENT_ID, validDto);
      expect(result.message).toBe('Equipamento atualizado com sucesso.');
    });

    it('terceiro recebe ForbiddenException', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(
        service.update(STRANGER_ID, EQUIPMENT_ID, validDto),
      ).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para editar este equipamento.',
        ),
      );
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.update(OWNER_ID, EQUIPMENT_ID, validDto),
      ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.update(OWNER_ID, EQUIPMENT_ID, validDto),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('lança BadRequestException se categoryId nova não existe ou está inativa', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.category.findFirst.mockResolvedValue(null);

      await expect(
        service.update(OWNER_ID, EQUIPMENT_ID, {
          ...validDto,
          categoryId: 'categoria-inexistente',
        }),
      ).rejects.toThrow(
        new BadRequestException('Categoria não encontrada ou inativa.'),
      );
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    it('não verifica categoria se categoryId não é fornecido', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.update(OWNER_ID, EQUIPMENT_ID, { title: 'Novo título' });

      expect(prisma.category.findFirst).not.toHaveBeenCalled();
    });

    it('faz trim no title, description e location', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.update(OWNER_ID, EQUIPMENT_ID, {
        title: '  Título  ',
        description: '  Descrição  ',
        location: '  Beira  ',
      });

      const updateCall = prisma.equipment.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.title).toBe('Título');
      expect(updateCall.data.description).toBe('Descrição');
      expect(updateCall.data.location).toBe('Beira');
    });
  });

  // remove()

  describe('remove()', () => {
    it('OWNER remove o seu equipamento com sucesso (soft delete)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue({});

      const result = await service.remove(OWNER_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento removido com sucesso.');
    });

    it('faz soft delete — status DELETED e isAvailable=false', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue({});

      await service.remove(OWNER_ID, EQUIPMENT_ID);

      const updateCall = prisma.equipment.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).toMatchObject({
        status: EquipmentStatus.DELETED,
        isAvailable: false,
      });
    });

    it('não usa prisma.equipment.delete — é soft delete', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.update.mockResolvedValue({});

      await service.remove(OWNER_ID, EQUIPMENT_ID);

      // O mock nao tem delete - se fosse chamado, o teste rebentaria.
      // Verificamos que update foi chamado em vez disso.
      expect(prisma.equipment.update).toHaveBeenCalledTimes(1);
    });

    it('ADMIN remove qualquer equipamento', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.update.mockResolvedValue({});

      const result = await service.remove(ADMIN_ID, EQUIPMENT_ID);
      expect(result.message).toBe('Equipamento removido com sucesso.');
    });

    it('terceiro recebe ForbiddenException', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(service.remove(STRANGER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para remover este equipamento.',
        ),
      );
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(service.remove(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.remove(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });
  });

  // findPending()

  describe('findPending()', () => {
    it('ADMIN obtém equipamentos PENDING_REVIEW', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findMany.mockResolvedValue([
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW }),
      ]);

      const result = await service.findPending(ADMIN_ID);
      expect(result.message).toBe(
        'Equipamentos pendentes de revisão obtidos com sucesso.',
      );
      expect(result.data).toHaveLength(1);
    });

    it('filtra apenas PENDING_REVIEW na query', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.equipment.findMany.mockResolvedValue([]);

      await service.findPending(ADMIN_ID);

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({
        status: EquipmentStatus.PENDING_REVIEW,
      });
    });

    it('CLIENT recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(service.findPending(STRANGER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('utilizador inexistente recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findPending('fantasma')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // Moderação: o que volta à revisão e o que continua público

  describe('moderação das edições', () => {
    const asOwner = () =>
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

    /** O anúncio como o update() o lê, e o que a base devolve depois. */
    const editing = (overrides: Partial<Record<string, unknown>> = {}) => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment(overrides));
      prisma.equipment.update.mockResolvedValue(makeEquipment(overrides));
    };

    const updateData = () =>
      (
        prisma.equipment.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;

    // A app envia o formulário inteiro em cada gravação.
    const wholeForm = {
      title: 'Betoneira 300L',
      description: 'Betoneira em bom estado',
      categoryId: CATEGORY_ID,
      pricePerDay: 500,
      depositAmount: 1000,
      location: 'Maputo',
    };

    it('fica activo quando o formulário vem inteiro e só muda o preço', async () => {
      asOwner();
      editing();

      const result = await service.update(OWNER_ID, EQUIPMENT_ID, {
        ...wholeForm,
        pricePerDay: 650,
      });

      expect(updateData().status).toBeUndefined();
      expect(result.message).toBe('Equipamento atualizado com sucesso.');
      expect(audit.record).not.toHaveBeenCalled();
      expect(prisma.category.findFirst).not.toHaveBeenCalled();
    });

    it('volta à revisão quando o dono muda o título, e fica em auditoria', async () => {
      asOwner();
      editing();

      const result = await service.update(OWNER_ID, EQUIPMENT_ID, {
        ...wholeForm,
        title: 'Gerador 50 kVA',
      });

      expect(updateData().status).toBe(EquipmentStatus.PENDING_REVIEW);
      expect(result.message).toContain('volta à revisão');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.EQUIPMENT_SENT_TO_REVIEW,
          actorId: OWNER_ID,
          targetId: EQUIPMENT_ID,
          metadata: expect.objectContaining({
            previousStatus: EquipmentStatus.ACTIVE,
            changed: ['title'],
          }) as object,
        }),
      );
    });

    it('fica activo quando o dono é um provider verificado', async () => {
      asOwner();
      editing();
      verifications.isVerified.mockResolvedValue(true);

      await service.update(OWNER_ID, EQUIPMENT_ID, { title: 'Gerador 50 kVA' });

      expect(updateData().status).toBeUndefined();
    });

    it('fica activo quando é um admin a editar', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      editing();

      await service.update(ADMIN_ID, EQUIPMENT_ID, { title: 'Gerador 50 kVA' });

      expect(updateData().status).toBeUndefined();
    });

    it('um anúncio rejeitado volta à revisão com qualquer mudança, mesmo só o preço', async () => {
      asOwner();
      editing({ status: EquipmentStatus.REJECTED });

      const result = await service.update(OWNER_ID, EQUIPMENT_ID, {
        ...wholeForm,
        pricePerDay: 650,
      });

      expect(updateData().status).toBe(EquipmentStatus.PENDING_REVIEW);
      expect(result.message).toContain('enviado de novo para revisão');
    });

    it('um anúncio rejeitado fica como está quando a edição não muda nada', async () => {
      asOwner();
      editing({ status: EquipmentStatus.REJECTED });

      await service.update(OWNER_ID, EQUIPMENT_ID, wholeForm);

      expect(updateData().status).toBeUndefined();
    });

    it('responde 404 a um anúncio removido', async () => {
      asOwner();
      editing({ status: EquipmentStatus.DELETED });

      await expect(
        service.update(OWNER_ID, EQUIPMENT_ID, wholeForm),
      ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    describe('quantidade', () => {
      const day = (offset: number) =>
        new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
      const booking = (from: number, to: number) => ({
        status: BookingStatus.CONFIRMED,
        startDate: day(from),
        endDate: day(to),
      });

      it('recusa baixar a quantidade abaixo das unidades com reserva ao mesmo tempo', async () => {
        asOwner();
        editing({ quantity: 3 });
        prisma.booking.findMany.mockResolvedValue([
          booking(2, 6),
          booking(4, 8),
        ]);

        await expect(
          service.update(OWNER_ID, EQUIPMENT_ID, { quantity: 1 }),
        ).rejects.toThrow(
          new BadRequestException(
            'Este equipamento tem reservas para 2 unidades ao mesmo tempo. A quantidade não pode ficar abaixo disso.',
          ),
        );
        expect(prisma.equipment.update).not.toHaveBeenCalled();
      });

      it('aceita baixar até às unidades que as reservas ocupam', async () => {
        asOwner();
        editing({ quantity: 3 });
        prisma.booking.findMany.mockResolvedValue([
          booking(2, 6),
          booking(4, 8),
        ]);

        await service.update(OWNER_ID, EQUIPMENT_ID, { quantity: 2 });

        expect(updateData().quantity).toBe(2);
        expect(updateData().status).toBeUndefined();
      });

      it('aumenta a quantidade sem olhar para as reservas', async () => {
        asOwner();
        editing({ quantity: 1 });

        await service.update(OWNER_ID, EQUIPMENT_ID, { quantity: 4 });

        expect(prisma.booking.findMany).not.toHaveBeenCalled();
        expect(updateData().quantity).toBe(4);
      });
    });
  });

  describe('moderação das fotos', () => {
    const photosOf = (status: EquipmentStatus) => ({
      actorId: OWNER_ID,
      actorRole: UserRole.PROVIDER,
      equipment: { id: EQUIPMENT_ID, ownerId: OWNER_ID, status },
    });

    it('uma foto nova devolve um anúncio activo à revisão', async () => {
      const backToReview = await service.reviewAfterPhotoChange({
        ...photosOf(EquipmentStatus.ACTIVE),
        addedPhotos: true,
      });

      expect(backToReview).toBe(true);
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { status: EquipmentStatus.PENDING_REVIEW },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.EQUIPMENT_SENT_TO_REVIEW,
          metadata: {
            previousStatus: EquipmentStatus.ACTIVE,
            changed: ['photos'],
          },
        }),
      );
    });

    it('tirar uma foto não mexe num anúncio activo', async () => {
      const backToReview = await service.reviewAfterPhotoChange({
        ...photosOf(EquipmentStatus.ACTIVE),
        addedPhotos: false,
      });

      expect(backToReview).toBe(false);
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    it('qualquer mudança nas fotos pede nova revisão de um anúncio rejeitado', async () => {
      const backToReview = await service.reviewAfterPhotoChange({
        ...photosOf(EquipmentStatus.REJECTED),
        addedPhotos: false,
      });

      expect(backToReview).toBe(true);
    });

    it('as fotos de um anúncio ainda por rever não mudam nada', async () => {
      const backToReview = await service.reviewAfterPhotoChange({
        ...photosOf(EquipmentStatus.PENDING_REVIEW),
        addedPhotos: true,
      });

      expect(backToReview).toBe(false);
    });
  });

  describe('rejeição e aprovação', () => {
    const asAdmin = () =>
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );

    const updateData = () =>
      (
        prisma.equipment.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;

    it('a rejeição guarda o motivo no anúncio e avisa o dono', async () => {
      asAdmin();
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
      });
      prisma.equipment.update.mockResolvedValue(
        makeEquipment({
          status: EquipmentStatus.REJECTED,
          owner: {
            id: OWNER_ID,
            name: 'Proprietário',
            avatarUrl: null,
            pushToken: 'ExponentPushToken[dono]',
          },
        }),
      );

      await service.reject(ADMIN_ID, EQUIPMENT_ID, '  Fotos insuficientes.  ');

      expect(updateData()).toMatchObject({
        status: EquipmentStatus.REJECTED,
        rejectionReason: 'Fotos insuficientes.',
        rejectedAt: expect.any(Date) as Date,
      });
      expect(push.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'ExponentPushToken[dono]',
          title: 'Anúncio rejeitado',
          body: '"Betoneira 300L" não foi aprovado. Motivo: Fotos insuficientes. Corrige o anúncio e guarda para pedir nova revisão.',
        }),
      );
    });

    it('a aprovação limpa o motivo de uma rejeição anterior', async () => {
      asAdmin();
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.REJECTED,
        owner: { listingsSuspendedUntil: null },
      });
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.approve(ADMIN_ID, EQUIPMENT_ID);

      expect(updateData()).toMatchObject({
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
        rejectionReason: null,
        rejectedAt: null,
      });
    });

    it('a aprovação não desfaz uma suspensão por strikes: o anúncio fica pausado', async () => {
      asAdmin();
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        status: EquipmentStatus.PENDING_REVIEW,
        owner: {
          listingsSuspendedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      prisma.equipment.update.mockResolvedValue(makeEquipment());

      await service.approve(ADMIN_ID, EQUIPMENT_ID);

      expect(updateData()).toMatchObject({
        status: EquipmentStatus.ACTIVE,
        isAvailable: false,
      });
    });
  });

  describe('catálogo e conta do dono', () => {
    it('a listagem pública deixa de fora os anúncios de contas suspensas', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);

      await service.findAll({ page: 1, limit: 10 });

      expect(prisma.equipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            owner: { isActive: true },
          }) as object,
        }),
      );
    });

    it('o detalhe público também', async () => {
      prisma.equipment.findFirst.mockResolvedValue(makeEquipment());

      await service.findOne(EQUIPMENT_ID);

      expect(prisma.equipment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: EQUIPMENT_ID,
            status: EquipmentStatus.ACTIVE,
            owner: { isActive: true },
          },
        }),
      );
    });

    it('o detalhe público dá a localização à zona, não à porta', async () => {
      prisma.equipment.findFirst.mockResolvedValue(
        makeEquipment({
          latitude: new Prisma.Decimal('-25.9653217'),
          longitude: new Prisma.Decimal('32.5892461'),
        }),
      );

      const result = await service.findOne(EQUIPMENT_ID);

      expect(result.data.latitude).toBe(-25.97);
      expect(result.data.longitude).toBe(32.59);
    });

    it('o dono lê o seu anúncio em revisão, com a localização exacta e o motivo da rejeição', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({
          status: EquipmentStatus.REJECTED,
          rejectionReason: 'Fotos insuficientes.',
          latitude: new Prisma.Decimal('-25.9653217'),
          longitude: new Prisma.Decimal('32.5892461'),
        }),
      );

      const result = await service.findMine(OWNER_ID, EQUIPMENT_ID);

      expect(result.data).toMatchObject({
        status: EquipmentStatus.REJECTED,
        rejectionReason: 'Fotos insuficientes.',
        latitude: -25.9653217,
        longitude: 32.5892461,
      });
    });

    it('outra conta não lê o anúncio pelo detalhe do dono', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW }),
      );

      await expect(service.findMine(STRANGER_ID, EQUIPMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('o detalhe do dono responde 404 a um anúncio removido', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.DELETED }),
      );

      await expect(service.findMine(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('a criação recusa uma categoria de serviços e não muda o papel da conta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.CLIENT),
      );
      prisma.category.findFirst.mockResolvedValue(
        makeCategory({ kind: 'SERVICE' }),
      );

      await expect(
        service.create(OWNER_ID, {
          categoryId: CATEGORY_ID,
          title: 'Betoneira 300L',
          description: 'Betoneira em bom estado',
          pricePerDay: 500,
          depositAmount: 1000,
          location: 'Maputo',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Esta categoria é de serviços. Escolhe uma categoria de equipamentos.',
        ),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.equipment.create).not.toHaveBeenCalled();
    });

    it('o dashboard só soma o dinheiro que foi mesmo pago ao provider', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { ownerPayout: null, totalCharged: null },
        _count: { _all: 0 },
      });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await service.getProviderAnalytics(OWNER_ID);

      expect(prisma.payment.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ownerId: OWNER_ID,
            status: {
              in: [PaymentStatus.RELEASED, PaymentStatus.PARTIALLY_REFUNDED],
            },
          },
        }),
      );
    });
  });

  describe('remoção com reservas', () => {
    it('recusa remover um equipamento com reservas em curso', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.booking.count.mockResolvedValue(1);

      await expect(service.remove(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new BadRequestException(
          'Este equipamento tem reservas em curso. Pausa o anúncio para não receber mais e remove-o quando elas terminarem.',
        ),
      );
      expect(prisma.equipment.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('responde 404 a um equipamento que já foi removido', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.DELETED }),
      );

      await expect(service.remove(OWNER_ID, EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });
  });
});
