import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BookingStatus, EquipmentStatus, Prisma, UserRole } from '@prisma/client';

import { BookingsService } from './bookings.service';
import { PrismaService } from '../../../shared/db/prisma.service';

// ─────────────────────────────────────────────────────────────────────────────
// FACTORIES DE DADOS DE TESTE
// Centralizar a construção de dados evita repetição e torna os testes legíveis.
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const CATEGORY_ID = 'category-uuid-001';

/** Datas sempre no futuro para não quebrar a validação "no passado". */
const future = (daysFromNow: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(0, 0, 0, 0);
  return d;
};

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
  condition: 'GOOD',
  status: EquipmentStatus.ACTIVE,
  isPremium: false,
  totalRating: null,
  totalReviews: 0,
  totalBookings: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  category: { id: CATEGORY_ID, name: 'Construção', slug: 'construcao' },
  ...overrides,
});

const makeUser = (id: string, role: UserRole) => ({
  id,
  name: role === UserRole.ADMIN ? 'Admin' : role === UserRole.OWNER ? 'Proprietário' : 'Cliente',
  phone: `+258${id.slice(0, 9)}`,
  email: null,
  passwordHash: 'hash',
  role,
  isVerified: true,
  isActive: true,
  avatarUrl: null,
  bio: null,
  totalRating: null,
  totalReviews: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeBooking = (overrides: Partial<Record<string, unknown>> = {}) => {
  const start = future(5);
  const end = future(8);
  return {
    id: BOOKING_ID,
    clientId: CLIENT_ID,
    equipmentId: EQUIPMENT_ID,
    ownerId: OWNER_ID,
    startDate: start,
    endDate: end,
    totalDays: 3,
    rentalAmount: new Prisma.Decimal(1500),
    depositAmount: new Prisma.Decimal(1000),
    platformFee: new Prisma.Decimal(150),
    totalAmount: new Prisma.Decimal(2650),
    status: BookingStatus.PENDING,
    deliveryAddress: null,
    clientNote: null,
    confirmedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
    owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
    equipment: {
      id: EQUIPMENT_ID,
      title: 'Betoneira 300L',
      location: 'Maputo',
      status: EquipmentStatus.ACTIVE,
    },
    ...overrides,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DO PRISMA SERVICE
// Usamos jest.fn() em cada método para controlar o comportamento em cada teste.
// A abordagem de fábrica (makePrisma) garante isolamento entre testes.
// ─────────────────────────────────────────────────────────────────────────────

type TxClient = {
  booking: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
};

const makePrismaMock = () => {
  const mock = {
    equipment: { findUnique: jest.fn() },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    // $transaction simula o comportamento real:
    // recebe um callback e chama-o com um tx mock que tem booking.findFirst e create.
    $transaction: jest.fn(),
  };
  return mock;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUITE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

describe('BookingsService', () => {
  let service: BookingsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<BookingsService>(BookingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // create()
  // ───────────────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const validDto = {
      equipmentId: EQUIPMENT_ID,
      startDate: future(5).toISOString().split('T')[0],
      endDate: future(8).toISOString().split('T')[0],
      deliveryAddress: undefined as string | undefined,
      clientNote: undefined as string | undefined,
    };

    /** Configura o mock do $transaction para simular transacção feliz. */
    const setupHappyTransaction = (
      txFindFirstResult: unknown = null,
      txCreateResult: unknown = makeBooking(),
    ) => {
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              findFirst: jest.fn().mockResolvedValue(txFindFirstResult),
              create: jest.fn().mockResolvedValue(txCreateResult),
            },
          };
          return callback(tx);
        },
      );
    };

    it('cria a reserva com sucesso e devolve os dados formatados', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      setupHappyTransaction(null, makeBooking());

      const result = await service.create(CLIENT_ID, validDto);

      expect(result.message).toBe('Reserva criada com sucesso.');
      expect(result.data.id).toBe(BOOKING_ID);
      expect(result.data.status).toBe(BookingStatus.PENDING);
    });

    it('calcula rentalAmount, platformFee e totalAmount correctamente', async () => {
      // pricePerDay = 500 MZN, 3 dias → rental = 1500, fee = 150, deposit = 1000, total = 2650
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      const booking = makeBooking();
      setupHappyTransaction(null, booking);

      const result = await service.create(CLIENT_ID, validDto);

      expect(result.data.rentalAmount).toBe(1500);
      expect(result.data.platformFee).toBe(150);
      expect(result.data.depositAmount).toBe(1000);
      expect(result.data.totalAmount).toBe(2650);
    });

    it('lança NotFoundException se equipamento não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('lança BadRequestException se equipamento não está ACTIVE', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.PAUSED }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException('Este equipamento não está disponível para reserva.'),
      );
    });

    it('lança BadRequestException se equipamento não está disponível (isAvailable=false)', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ isAvailable: false }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException('Este equipamento não está disponível.'),
      );
    });

    it('lança BadRequestException se cliente tenta reservar o seu próprio equipamento', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ ownerId: CLIENT_ID }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException('Não podes reservar o teu próprio equipamento.'),
      );
    });

    it('lança BadRequestException se a data inicial é no passado', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      await expect(
        service.create(CLIENT_ID, {
          ...validDto,
          startDate: yesterday.toISOString().split('T')[0],
          endDate: future(3).toISOString().split('T')[0],
        }),
      ).rejects.toThrow(
        new BadRequestException('A data inicial não pode ser no passado.'),
      );
    });

    it('lança BadRequestException se data final é igual à data inicial', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      const sameDay = future(3).toISOString().split('T')[0];

      await expect(
        service.create(CLIENT_ID, { ...validDto, startDate: sameDay, endDate: sameDay }),
      ).rejects.toThrow(
        new BadRequestException('A data final deve ser maior que a data inicial.'),
      );
    });

    it('lança BadRequestException se data final é anterior à data inicial', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      await expect(
        service.create(CLIENT_ID, {
          ...validDto,
          startDate: future(5).toISOString().split('T')[0],
          endDate: future(3).toISOString().split('T')[0],
        }),
      ).rejects.toThrow(
        new BadRequestException('A data final deve ser maior que a data inicial.'),
      );
    });

    it('lança BadRequestException se existe reserva conflituosa (dentro da transacção)', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      // A transacção devolve um conflito → o callback lança BadRequestException
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              findFirst: jest.fn().mockResolvedValue({ id: 'conflicting-booking' }),
              create: jest.fn(),
            },
          };
          return callback(tx);
        },
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'Já existe uma reserva para este equipamento nesse período.',
        ),
      );
    });

    it('converte erro P2034 (serialization failure) em BadRequestException legível', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      const p2034 = new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict or a deadlock',
        { code: 'P2034', clientVersion: '5.0.0' },
      );
      prisma.$transaction.mockRejectedValue(p2034);

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'Já existe uma reserva para este equipamento nesse período.',
        ),
      );
    });

    it('usa $transaction (não faz create fora da transacção)', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      setupHappyTransaction();

      await service.create(CLIENT_ID, validDto);

      // A criação real deve ocorrer dentro de $transaction, não directamente no prisma
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });

    it('passa deliveryAddress e clientNote trimadas correctamente', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      // Usamos container object em vez de `let x = null` porque o TypeScript
      // não consegue rastrear atribuições dentro de callbacks assíncronos de mocks
      // — inferiria `capturedData` como `never` após o await.
      const captured = { data: {} as Record<string, unknown> };
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockImplementation(({ data }) => {
                captured.data = data as Record<string, unknown>;
                return Promise.resolve(makeBooking());
              }),
            },
          };
          return callback(tx);
        },
      );

      await service.create(CLIENT_ID, {
        ...validDto,
        deliveryAddress: '  Maputo, Bairro Central  ',
        clientNote: '  Preciso em bom estado.  ',
      });

      expect(captured.data.deliveryAddress).toBe('Maputo, Bairro Central');
      expect(captured.data.clientNote).toBe('Preciso em bom estado.');
    });

    it('não guarda deliveryAddress nem clientNote quando omitidos', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      const captured = { data: {} as Record<string, unknown> };
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockImplementation(({ data }) => {
                captured.data = data as Record<string, unknown>;
                return Promise.resolve(makeBooking());
              }),
            },
          };
          return callback(tx);
        },
      );

      await service.create(CLIENT_ID, validDto);

      expect(captured.data.deliveryAddress).toBeNull();
      expect(captured.data.clientNote).toBeNull();
    });

    it('relança erros não-P2034 sem os alterar', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      const unexpected = new Error('Falha inesperada de rede');
      prisma.$transaction.mockRejectedValue(unexpected);

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(unexpected);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findMyBookings()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findMyBookings()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findMyBookings(CLIENT_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('CLIENT vê apenas as suas reservas (filtra por clientId)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.findMyBookings(CLIENT_ID, { page: 1, limit: 10 });

      const whereArg = (prisma.booking.findMany.mock.calls[0][0] as { where: Prisma.BookingWhereInput }).where;
      expect(whereArg).toMatchObject({ clientId: CLIENT_ID });
      expect(result.data).toHaveLength(1);
    });

    it('ADMIN vê todas as reservas (sem filtro de clientId)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(ADMIN_ID, UserRole.ADMIN));
      prisma.booking.findMany.mockResolvedValue([makeBooking(), makeBooking()]);
      prisma.booking.count.mockResolvedValue(2);

      const result = await service.findMyBookings(ADMIN_ID, { page: 1, limit: 10 });

      const whereArg = (prisma.booking.findMany.mock.calls[0][0] as { where: Prisma.BookingWhereInput }).where;
      expect(whereArg).not.toHaveProperty('clientId');
      expect(result.data).toHaveLength(2);
    });

    it('filtra por status quando fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.findMyBookings(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: BookingStatus.CONFIRMED,
      });

      const whereArg = (prisma.booking.findMany.mock.calls[0][0] as { where: Prisma.BookingWhereInput }).where;
      expect(whereArg).toMatchObject({ status: BookingStatus.CONFIRMED });
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(25);

      const result = await service.findMyBookings(CLIENT_ID, { page: 2, limit: 10 });

      expect(result.meta).toMatchObject({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('hasPreviousPage = false na primeira página', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      const result = await service.findMyBookings(CLIENT_ID, { page: 1, limit: 10 });

      expect(result.meta.hasPreviousPage).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findOwnerBookings()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findOwnerBookings()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findOwnerBookings(OWNER_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('OWNER vê apenas as suas reservas (filtra por ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      await service.findOwnerBookings(OWNER_ID, { page: 1, limit: 10 });

      const whereArg = (prisma.booking.findMany.mock.calls[0][0] as { where: Prisma.BookingWhereInput }).where;
      expect(whereArg).toMatchObject({ ownerId: OWNER_ID });
    });

    it('ADMIN vê todas (sem filtro de ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(ADMIN_ID, UserRole.ADMIN));
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.findOwnerBookings(ADMIN_ID, { page: 1, limit: 10 });

      const whereArg = (prisma.booking.findMany.mock.calls[0][0] as { where: Prisma.BookingWhereInput }).where;
      expect(whereArg).not.toHaveProperty('ownerId');
    });

    it('devolve mensagem correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      const result = await service.findOwnerBookings(OWNER_ID, { page: 1, limit: 10 });

      expect(result.message).toBe('Reservas do proprietário obtidas com sucesso.');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findOne()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: { id: EQUIPMENT_ID, title: 'X', description: null, location: 'Maputo', status: 'ACTIVE', pricePerDay: 500, depositAmount: 1000 } }),
      );
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT pode ver a sua própria reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: { id: EQUIPMENT_ID, title: 'X', description: null, location: 'Maputo', status: 'ACTIVE', pricePerDay: 500, depositAmount: 1000 } }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      const result = await service.findOne(CLIENT_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('OWNER pode ver a reserva do seu equipamento', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: { id: EQUIPMENT_ID, title: 'X', description: null, location: 'Maputo', status: 'ACTIVE', pricePerDay: 500, depositAmount: 1000 } }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));

      const result = await service.findOne(OWNER_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('ADMIN pode ver qualquer reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: { id: EQUIPMENT_ID, title: 'X', description: null, location: 'Maputo', status: 'ACTIVE', pricePerDay: 500, depositAmount: 1000 } }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(ADMIN_ID, UserRole.ADMIN));

      const result = await service.findOne(ADMIN_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('utilizador sem relação com a reserva recebe ForbiddenException', async () => {
      const strangerBooking = makeBooking({
        clientId: 'outro-client',
        ownerId: 'outro-owner',
        equipment: { id: EQUIPMENT_ID, title: 'X', description: null, location: 'Maputo', status: 'ACTIVE', pricePerDay: 500, depositAmount: 1000 },
      });
      prisma.booking.findUnique.mockResolvedValue(strangerBooking);
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new ForbiddenException('Não tens permissão para ver esta reserva.'),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // confirm()
  // ───────────────────────────────────────────────────────────────────────────

  describe('confirm()', () => {
    const makeBookingWithEquipment = (statusOverride: BookingStatus = BookingStatus.PENDING) =>
      makeBooking({
        status: statusOverride,
        equipment: {
          id: EQUIPMENT_ID,
          status: EquipmentStatus.ACTIVE,
          isAvailable: true,
        },
      });

    const confirmedBooking = makeBooking({
      status: BookingStatus.CONFIRMED,
      confirmedAt: new Date(),
      equipment: { id: EQUIPMENT_ID, title: 'Betoneira', location: 'Maputo', status: 'ACTIVE' },
    });

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT não pode confirmar — recebe ForbiddenException', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      await expect(service.confirm(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new ForbiddenException('Não tens permissão para confirmar esta reserva.'),
      );
    });

    it('lança BadRequestException se reserva já não está PENDING', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBookingWithEquipment(BookingStatus.CONFIRMED),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException('Apenas reservas pendentes podem ser confirmadas.'),
      );
    });

    it('lança BadRequestException se equipamento não está ACTIVE', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          status: BookingStatus.PENDING,
          equipment: { id: EQUIPMENT_ID, status: EquipmentStatus.PAUSED, isAvailable: true },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException('Não é possível confirmar uma reserva de equipamento inativo.'),
      );
    });

    it('lança BadRequestException se equipamento isAvailable=false', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          status: BookingStatus.PENDING,
          equipment: { id: EQUIPMENT_ID, status: EquipmentStatus.ACTIVE, isAvailable: false },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException('Não é possível confirmar reserva de equipamento indisponível.'),
      );
    });

    it('lança BadRequestException se já existe reserva confirmada no mesmo período', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.findFirst.mockResolvedValue({ id: 'existing-confirmed' });

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Já existe outra reserva confirmada para este equipamento nesse período.',
        ),
      );
    });

    it('OWNER confirma com sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.findFirst.mockResolvedValue(null);
      prisma.booking.update.mockResolvedValue(confirmedBooking);

      const result = await service.confirm(OWNER_ID, BOOKING_ID);

      expect(result.message).toBe('Reserva confirmada com sucesso.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
        }),
      );
    });

    it('ADMIN confirma com sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(makeUser(ADMIN_ID, UserRole.ADMIN));
      prisma.booking.findFirst.mockResolvedValue(null);
      prisma.booking.update.mockResolvedValue(confirmedBooking);

      const result = await service.confirm(ADMIN_ID, BOOKING_ID);
      expect(result.message).toBe('Reserva confirmada com sucesso.');
    });

    it('grava confirmedAt na actualização', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.findFirst.mockResolvedValue(null);
      prisma.booking.update.mockResolvedValue(confirmedBooking);

      await service.confirm(OWNER_ID, BOOKING_ID);

      const updateCall = prisma.booking.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data.confirmedAt).toBeInstanceOf(Date);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // cancel()
  // ───────────────────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    const cancelledBooking = makeBooking({
      status: BookingStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: 'Já não preciso.',
    });

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.cancel(CLIENT_ID, BOOKING_ID, {}),
      ).rejects.toThrow(new NotFoundException('Reserva não encontrada.'));
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.cancel(CLIENT_ID, BOOKING_ID, {}),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('terceiro sem relação com a reserva recebe ForbiddenException', async () => {
      const booking = makeBooking({ clientId: 'outro-client', ownerId: 'outro-owner' });
      prisma.booking.findUnique.mockResolvedValue(booking);
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      await expect(
        service.cancel(CLIENT_ID, BOOKING_ID, {}),
      ).rejects.toThrow(new ForbiddenException('Não tens permissão para cancelar esta reserva.'));
    });

    it('lança BadRequestException para reserva COMPLETED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.COMPLETED }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      await expect(
        service.cancel(CLIENT_ID, BOOKING_ID, {}),
      ).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
        ),
      );
    });

    it('lança BadRequestException para reserva ACTIVE', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.ACTIVE }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));

      await expect(
        service.cancel(CLIENT_ID, BOOKING_ID, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('CLIENT cancela reserva PENDING com sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking({ status: BookingStatus.PENDING }));
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      const result = await service.cancel(CLIENT_ID, BOOKING_ID, {
        reason: 'Já não preciso.',
      });

      expect(result.message).toBe('Reserva cancelada com sucesso.');
      expect(result.data.status).toBe(BookingStatus.CANCELLED);
    });

    it('OWNER cancela reserva CONFIRMED com sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking({ status: BookingStatus.CONFIRMED }));
      prisma.user.findUnique.mockResolvedValue(makeUser(OWNER_ID, UserRole.OWNER));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      const result = await service.cancel(OWNER_ID, BOOKING_ID, {});
      expect(result.message).toBe('Reserva cancelada com sucesso.');
    });

    it('ADMIN cancela qualquer reserva PENDING', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ clientId: 'qualquer-client', status: BookingStatus.PENDING }),
      );
      prisma.user.findUnique.mockResolvedValue(makeUser(ADMIN_ID, UserRole.ADMIN));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      const result = await service.cancel(ADMIN_ID, BOOKING_ID, {});
      expect(result.message).toBe('Reserva cancelada com sucesso.');
    });

    it('grava cancellationReason trimada', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking({ status: BookingStatus.PENDING }));
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      await service.cancel(CLIENT_ID, BOOKING_ID, { reason: '  Motivo com espaços  ' });

      const updateCall = prisma.booking.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data.cancellationReason).toBe('Motivo com espaços');
    });

    it('guarda null quando reason não é fornecido', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking({ status: BookingStatus.PENDING }));
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      const updateCall = prisma.booking.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data.cancellationReason).toBeNull();
    });

    it('grava cancelledAt na actualização', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking({ status: BookingStatus.PENDING }));
      prisma.user.findUnique.mockResolvedValue(makeUser(CLIENT_ID, UserRole.CLIENT));
      prisma.booking.update.mockResolvedValue(cancelledBooking);

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      const updateCall = prisma.booking.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data.cancelledAt).toBeInstanceOf(Date);
    });
  });
});