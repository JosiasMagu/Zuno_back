import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EquipmentCondition,
  EquipmentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { EquipmentSortBy } from '../dto/find-equipment-query.dto';
import { EquipmentService } from './equipment.service';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const CATEGORY_ID = 'category-uuid-001';

// ─────────────────────────────────────────────────────────────────────────────
// FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DO PRISMA
// ─────────────────────────────────────────────────────────────────────────────

const makePrismaMock = () => ({
  equipment: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  category: {
    findFirst: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

describe('EquipmentService', () => {
  let service: EquipmentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<EquipmentService>(EquipmentService);
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────────────────────────────────────────────────────────
  // create()
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // findAll()
  // ───────────────────────────────────────────────────────────────────────────

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

    it('filtra por categoryId quando fornecido', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, categoryId: CATEGORY_ID });

      const whereArg = (
        prisma.equipment.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ categoryId: CATEGORY_ID });
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

    it('ordena por RELEVANT com isPremium e totalBookings', async () => {
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
      expect(orderByArg[1]).toMatchObject({ totalBookings: 'desc' });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findOne()
  // ───────────────────────────────────────────────────────────────────────────

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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findMyListings()
  // ───────────────────────────────────────────────────────────────────────────

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

    it('ADMIN vê todos os equipamentos (sem filtro ownerId)', async () => {
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
      expect(whereArg).toEqual({});
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

  // ───────────────────────────────────────────────────────────────────────────
  // approve()
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // reject()
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // toggleAvailability()
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // update()
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // remove()
  // ───────────────────────────────────────────────────────────────────────────

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

      // O mock não tem delete — se fosse chamado, o teste rebentaria.
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

  // ───────────────────────────────────────────────────────────────────────────
  // findPending()
  // ───────────────────────────────────────────────────────────────────────────

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
});
