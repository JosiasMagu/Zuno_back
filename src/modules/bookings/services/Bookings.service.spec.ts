import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  DepositStatus,
  EquipmentStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  UserRole,
} from '@prisma/client';

import { BookingsService } from './bookings.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { AuditService } from '../../../shared/audit/audit.service';
import {
  CANCELLATION_FREE_WINDOW_HOURS,
  PROVIDER_STRIKE_LIMIT,
} from '../../../shared/constants/policy';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';

// FACTORIES DE DADOS DE TESTE
// Centralizar a construcao de dados evita repeticao e torna os testes legiveis.

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const CATEGORY_ID = 'category-uuid-001';

/** Datas sempre no futuro para não quebrar a validação "no passado". */
const future = (daysFromNow: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Data a N horas de agora — útil para testar a janela livre de cancelamento. */
const hoursFromNow = (hours: number): Date =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

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
  availableQuantity: 1,
  condition: 'GOOD',
  status: EquipmentStatus.ACTIVE,
  isPremium: false,
  totalRating: null,
  totalReviews: 0,
  totalBookings: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  owner: {
    id: OWNER_ID,
    name: 'Proprietário',
    avatarUrl: null,
    pushToken: null,
  },
  category: { id: CATEGORY_ID, name: 'Construção', slug: 'construcao' },
  ...overrides,
});

const makeUser = (id: string, role: UserRole) => ({
  id,
  name:
    role === UserRole.ADMIN
      ? 'Admin'
      : role === UserRole.PROVIDER
        ? 'Proprietário'
        : 'Cliente',
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
    returnConfirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    client: {
      id: CLIENT_ID,
      name: 'Cliente',
      avatarUrl: null,
      pushToken: null,
    },
    owner: {
      id: OWNER_ID,
      name: 'Proprietário',
      avatarUrl: null,
      pushToken: null,
    },
    equipment: {
      id: EQUIPMENT_ID,
      title: 'Betoneira 300L',
      location: 'Maputo',
      status: EquipmentStatus.ACTIVE,
      isAvailable: true,
      availableQuantity: 1,
      quantity: 1,
    },
    payment: null,
    ...overrides,
  };
};

/** Pagamento como re-lido dentro da transacção do cancel (select). */
const makeFreshPayment = (
  overrides: Partial<Record<string, unknown>> = {},
) => ({
  id: PAYMENT_ID,
  status: PaymentStatus.HELD,
  totalCharged: new Prisma.Decimal(1600),
  rentalAmount: new Prisma.Decimal(1000),
  depositStatus: DepositStatus.HELD,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  ...overrides,
});

/** Pagamento como re-lido dentro da transacção do complete (select). */
const makeDepositPayment = (
  overrides: Partial<Record<string, unknown>> = {},
) => ({
  id: PAYMENT_ID,
  status: PaymentStatus.RELEASED,
  depositStatus: DepositStatus.HELD,
  depositAmount: new Prisma.Decimal(1000),
  clientId: CLIENT_ID,
  ...overrides,
});

// MOCK DO PRISMA SERVICE
// Usamos jest.fn() em cada metodo para controlar o comportamento em cada teste.
// A abordagem de fabrica (makePrismaMock) garante isolamento entre testes.

type TxClient = {
  booking: {
    count: jest.Mock;
    create: jest.Mock;
  };
};

const makePrismaMock = () => ({
  equipment: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  booking: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  user: { findUnique: jest.fn(), update: jest.fn() },
  payment: { findUnique: jest.fn(), update: jest.fn() },
  providerStrike: { create: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
});

// SUITE PRINCIPAL

describe('BookingsService', () => {
  let service: BookingsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let push: { send: jest.Mock };
  let audit: { record: jest.Mock };
  let ledger: { record: jest.Mock; recordMany: jest.Mock; balance: jest.Mock };
  let payouts: { createPending: jest.Mock };

  /**
   * Padrão de transacção: o callback recebe o próprio mock do prisma como tx.
   * Assim os métodos re-lidos dentro da transacção (tx.booking.findUnique,
   * tx.payment.findUnique, etc.) usam os mesmos jest.fn() — controlamos as
   * re-leituras com mockResolvedValueOnce em sequência.
   */
  const useRealTransaction = () => {
    prisma.$transaction.mockImplementation(
      (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
    );
  };

  beforeEach(async () => {
    prisma = makePrismaMock();
    push = { send: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn() };
    ledger = { record: jest.fn(), recordMany: jest.fn(), balance: jest.fn() };
    payouts = { createPending: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: push },
        { provide: AuditService, useValue: audit },
        { provide: LedgerService, useValue: ledger },
        { provide: PayoutsService, useValue: payouts },
      ],
    }).compile();

    service = module.get<BookingsService>(BookingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // create()

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
      txConflictCount = 0,
      txCreateResult: unknown = makeBooking(),
    ) => {
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              count: jest.fn().mockResolvedValue(txConflictCount),
              create: jest.fn().mockResolvedValue(txCreateResult),
            },
          };
          return callback(tx);
        },
      );
    };

    it('cria a reserva com sucesso e devolve os dados formatados', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      setupHappyTransaction(0, makeBooking());

      const result = await service.create(CLIENT_ID, validDto);

      expect(result.message).toBe('Reserva criada com sucesso.');
      expect(result.data.id).toBe(BOOKING_ID);
      expect(result.data.status).toBe(BookingStatus.PENDING);
    });

    it('calcula rentalAmount, platformFee e totalAmount correctamente', async () => {
      // pricePerDay = 500 MZN, 3 dias → rental = 1500, fee = 150, deposit = 1000, total = 2650
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      const booking = makeBooking();
      setupHappyTransaction(0, booking);

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
        new BadRequestException(
          'Este equipamento não está disponível para reserva.',
        ),
      );
    });

    it('lança BadRequestException se não há unidades disponíveis (availableQuantity=0)', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ availableQuantity: 0 }),
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
        new BadRequestException(
          'Não podes reservar o teu próprio equipamento.',
        ),
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
        service.create(CLIENT_ID, {
          ...validDto,
          startDate: sameDay,
          endDate: sameDay,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'A data final deve ser maior que a data inicial.',
        ),
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
        new BadRequestException(
          'A data final deve ser maior que a data inicial.',
        ),
      );
    });

    it('lança BadRequestException se as reservas conflituosas esgotam as unidades (dentro da transacção)', async () => {
      // quantity = 1 e já existe 1 reserva sobreposta → sem unidades livres
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      setupHappyTransaction(1);

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'Não há unidades disponíveis para este equipamento nesse período.',
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

      // A criacao real deve ocorrer dentro de $transaction, nao directamente no prisma
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });

    it('passa deliveryAddress e clientNote trimadas correctamente', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());

      // Usamos container object em vez de `let x = null` porque o TypeScript
      // nao consegue rastrear atribuicoes dentro de callbacks assincronos de mocks
      // inferiria `capturedData` como `never` apos o await.
      const captured = { data: {} as Record<string, unknown> };
      prisma.$transaction.mockImplementation(
        async (callback: (tx: TxClient) => Promise<unknown>) => {
          const tx: TxClient = {
            booking: {
              count: jest.fn().mockResolvedValue(0),
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
              count: jest.fn().mockResolvedValue(0),
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

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        unexpected,
      );
    });
  });

  // findMyBookings()

  describe('findMyBookings()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findMyBookings(CLIENT_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('CLIENT vê apenas as suas reservas (filtra por clientId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.findMyBookings(CLIENT_ID, {
        page: 1,
        limit: 10,
      });

      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Prisma.BookingWhereInput;
        }
      ).where;
      expect(whereArg).toMatchObject({ clientId: CLIENT_ID });
      expect(result.data).toHaveLength(1);
    });

    it('ADMIN vê todas as reservas (sem filtro de clientId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.booking.findMany.mockResolvedValue([makeBooking(), makeBooking()]);
      prisma.booking.count.mockResolvedValue(2);

      const result = await service.findMyBookings(ADMIN_ID, {
        page: 1,
        limit: 10,
      });

      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Prisma.BookingWhereInput;
        }
      ).where;
      expect(whereArg).not.toHaveProperty('clientId');
      expect(result.data).toHaveLength(2);
    });

    it('filtra por status quando fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.findMyBookings(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: BookingStatus.CONFIRMED,
      });

      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Prisma.BookingWhereInput;
        }
      ).where;
      expect(whereArg).toMatchObject({ status: BookingStatus.CONFIRMED });
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(25);

      const result = await service.findMyBookings(CLIENT_ID, {
        page: 2,
        limit: 10,
      });

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
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      const result = await service.findMyBookings(CLIENT_ID, {
        page: 1,
        limit: 10,
      });

      expect(result.meta.hasPreviousPage).toBe(false);
    });
  });

  // findOwnerBookings()

  describe('findOwnerBookings()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findOwnerBookings(OWNER_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('OWNER vê apenas as suas reservas (filtra por ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.booking.findMany.mockResolvedValue([makeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      await service.findOwnerBookings(OWNER_ID, { page: 1, limit: 10 });

      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Prisma.BookingWhereInput;
        }
      ).where;
      expect(whereArg).toMatchObject({ ownerId: OWNER_ID });
    });

    it('ADMIN vê todas (sem filtro de ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.findOwnerBookings(ADMIN_ID, { page: 1, limit: 10 });

      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Prisma.BookingWhereInput;
        }
      ).where;
      expect(whereArg).not.toHaveProperty('ownerId');
    });

    it('devolve mensagem correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      const result = await service.findOwnerBookings(OWNER_ID, {
        page: 1,
        limit: 10,
      });

      expect(result.message).toBe(
        'Reservas do proprietário obtidas com sucesso.',
      );
    });
  });

  // findOne()

  describe('findOne()', () => {
    const detailsEquipment = {
      id: EQUIPMENT_ID,
      title: 'X',
      description: null,
      location: 'Maputo',
      status: 'ACTIVE',
      pricePerDay: 500,
      depositAmount: 1000,
    };

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: detailsEquipment }),
      );
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT pode ver a sua própria reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: detailsEquipment }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      const result = await service.findOne(CLIENT_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('OWNER pode ver a reserva do seu equipamento', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: detailsEquipment }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      const result = await service.findOne(OWNER_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('ADMIN pode ver qualquer reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ equipment: detailsEquipment }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );

      const result = await service.findOne(ADMIN_ID, BOOKING_ID);
      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('utilizador sem relação com a reserva recebe ForbiddenException', async () => {
      const strangerBooking = makeBooking({
        clientId: 'outro-client',
        ownerId: 'outro-owner',
        equipment: detailsEquipment,
      });
      prisma.booking.findUnique.mockResolvedValue(strangerBooking);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new ForbiddenException('Não tens permissão para ver esta reserva.'),
      );
    });
  });

  // confirm()

  describe('confirm()', () => {
    const makeConfirmEquipment = (
      overrides: Partial<Record<string, unknown>> = {},
    ) => ({
      id: EQUIPMENT_ID,
      status: EquipmentStatus.ACTIVE,
      isAvailable: true,
      availableQuantity: 1,
      quantity: 1,
      title: 'Betoneira 300L',
      ...overrides,
    });

    const makeBookingWithEquipment = (
      statusOverride: BookingStatus = BookingStatus.PENDING,
      equipmentOverrides: Partial<Record<string, unknown>> = {},
    ) =>
      makeBooking({
        status: statusOverride,
        equipment: makeConfirmEquipment(equipmentOverrides),
      });

    const confirmedBooking = makeBooking({
      status: BookingStatus.CONFIRMED,
      confirmedAt: new Date(),
    });

    /**
     * Configura as re-leituras dentro da transacção Serializable:
     * tx.booking.findUnique (status), tx.equipment.findUnique
     * (availableQuantity/quantity/status) e tx.booking.count (overlaps).
     */
    const setupConfirmTx = ({
      freshBooking = { status: BookingStatus.PENDING } as unknown,
      freshEquipment = {
        availableQuantity: 1,
        quantity: 1,
        status: EquipmentStatus.ACTIVE,
      } as unknown,
      overlapCount = 0,
    } = {}) => {
      prisma.booking.findUnique.mockResolvedValueOnce(freshBooking);
      prisma.equipment.findUnique.mockResolvedValue(freshEquipment);
      prisma.booking.count.mockResolvedValue(overlapCount);
      prisma.booking.update.mockResolvedValue(confirmedBooking);
      prisma.equipment.update.mockResolvedValue({});
      useRealTransaction();
    };

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
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.confirm(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para confirmar esta reserva.',
        ),
      );
    });

    it('lança BadRequestException se reserva já não está PENDING', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBookingWithEquipment(BookingStatus.CONFIRMED),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas pendentes podem ser confirmadas.',
        ),
      );
    });

    it('lança BadRequestException se equipamento não está ACTIVE', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBookingWithEquipment(BookingStatus.PENDING, {
          status: EquipmentStatus.PAUSED,
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível confirmar uma reserva de equipamento inativo.',
        ),
      );
    });

    it('lança BadRequestException se não há unidades disponíveis (leitura externa)', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBookingWithEquipment(BookingStatus.PENDING, {
          availableQuantity: 0,
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Não há unidades disponíveis para confirmar esta reserva.',
        ),
      );
    });

    it('re-leitura na transacção: reserva já não está PENDING → BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx({ freshBooking: { status: BookingStatus.CANCELLED } });

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas pendentes podem ser confirmadas.',
        ),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('re-leitura na transacção: unidades esgotadas entretanto → BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx({
        freshEquipment: {
          availableQuantity: 0,
          quantity: 1,
          status: EquipmentStatus.ACTIVE,
        },
      });

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Não há unidades disponíveis para confirmar esta reserva.',
        ),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se as reservas confirmadas sobrepostas esgotam as unidades', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx({ overlapCount: 1 });

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Todas as unidades já estão reservadas para este período.',
        ),
      );
    });

    it('OWNER confirma com sucesso e decrementa availableQuantity na transacção', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx();

      const result = await service.confirm(OWNER_ID, BOOKING_ID);

      expect(result.message).toBe('Reserva confirmada com sucesso.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
        }),
      );
      // Última unidade confirmada → decrementa e marca indisponível
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { availableQuantity: { decrement: 1 }, isAvailable: false },
      });
    });

    it('mantém isAvailable=true quando restam unidades após o decremento', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(BookingStatus.PENDING, {
          availableQuantity: 2,
          quantity: 3,
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx({
        freshEquipment: {
          availableQuantity: 2,
          quantity: 3,
          status: EquipmentStatus.ACTIVE,
        },
      });

      await service.confirm(OWNER_ID, BOOKING_ID);

      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { availableQuantity: { decrement: 1 }, isAvailable: true },
      });
    });

    it('ADMIN confirma com sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      setupConfirmTx();

      const result = await service.confirm(ADMIN_ID, BOOKING_ID);
      expect(result.message).toBe('Reserva confirmada com sucesso.');
    });

    it('grava confirmedAt na actualização', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        makeBookingWithEquipment(),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      setupConfirmTx();

      await service.confirm(OWNER_ID, BOOKING_ID);

      const updateCall = prisma.booking.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.confirmedAt).toBeInstanceOf(Date);
    });

    it('converte erro P2034 em BadRequestException de confirmação concorrente', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      const p2034 = new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict or a deadlock',
        { code: 'P2034', clientVersion: '5.0.0' },
      );
      prisma.$transaction.mockRejectedValue(p2034);

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Outra confirmação está em curso para este equipamento. Tenta novamente.',
        ),
      );
    });

    it('relança erros não-P2034 sem os alterar', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBookingWithEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      const unexpected = new Error('Falha inesperada de rede');
      prisma.$transaction.mockRejectedValue(unexpected);

      await expect(service.confirm(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        unexpected,
      );
    });
  });

  // cancel()

  describe('cancel()', () => {
    const cancelledBooking = makeBooking({
      status: BookingStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: 'Já não preciso.',
    });

    /**
     * Configura o fluxo completo do cancel dentro da transacção:
     * re-leitura do booking (status), update para CANCELLED, re-leitura do
     * equipamento (restauro de quantidade), re-leitura do payment e strikes.
     */
    const setupCancelTx = ({
      booking = makeBooking(),
      user = makeUser(CLIENT_ID, UserRole.CLIENT),
      freshPayment = null as unknown,
      freshEquipment = { availableQuantity: 0, quantity: 1 } as unknown,
      strikeCount = 1,
    } = {}) => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(booking) // leitura externa (include)
        .mockResolvedValueOnce({ status: booking.status }); // re-leitura na tx (select)
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.booking.update.mockResolvedValue(cancelledBooking);
      prisma.equipment.findUnique.mockResolvedValue(freshEquipment);
      prisma.equipment.update.mockResolvedValue({});
      prisma.equipment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique.mockResolvedValue(freshPayment);
      prisma.payment.update.mockResolvedValue({});
      prisma.providerStrike.create.mockResolvedValue({});
      prisma.providerStrike.count.mockResolvedValue(strikeCount);
      prisma.user.update.mockResolvedValue({});
      useRealTransaction();
    };

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('terceiro sem relação com a reserva recebe ForbiddenException', async () => {
      const booking = makeBooking({
        clientId: 'outro-client',
        ownerId: 'outro-owner',
      });
      prisma.booking.findUnique.mockResolvedValue(booking);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para cancelar esta reserva.',
        ),
      );
    });

    it('lança BadRequestException para reserva COMPLETED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.COMPLETED }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
        ),
      );
    });

    it('lança BadRequestException para reserva ACTIVE', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.ACTIVE }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('re-leitura na transacção: reserva já cancelada entretanto → BadRequestException', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(makeBooking({ status: BookingStatus.PENDING }))
        .mockResolvedValueOnce({ status: BookingStatus.CANCELLED });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      useRealTransaction();

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
        ),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('CLIENT cancela reserva PENDING sem pagamento — sem ledger, payout ou strike', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.PENDING }),
      });

      const result = await service.cancel(CLIENT_ID, BOOKING_ID, {
        reason: 'Já não preciso.',
      });

      expect(result.message).toBe('Reserva cancelada com sucesso.');
      expect(result.data.status).toBe(BookingStatus.CANCELLED);
      expect(ledger.record).not.toHaveBeenCalled();
      expect(ledger.recordMany).not.toHaveBeenCalled();
      expect(payouts.createPending).not.toHaveBeenCalled();
      expect(prisma.providerStrike.create).not.toHaveBeenCalled();
    });

    it('ADMIN cancela qualquer reserva PENDING', async () => {
      setupCancelTx({
        booking: makeBooking({
          clientId: 'qualquer-client',
          status: BookingStatus.PENDING,
        }),
        user: makeUser(ADMIN_ID, UserRole.ADMIN),
      });

      const result = await service.cancel(ADMIN_ID, BOOKING_ID, {});
      expect(result.message).toBe('Reserva cancelada com sucesso.');
    });

    it('grava cancellationReason trimada', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.PENDING }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {
        reason: '  Motivo com espaços  ',
      });

      const updateCall = prisma.booking.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.cancellationReason).toBe('Motivo com espaços');
    });

    it('guarda null quando reason não é fornecido', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.PENDING }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      const updateCall = prisma.booking.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.cancellationReason).toBeNull();
    });

    it('grava cancelledAt na actualização', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.PENDING }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      const updateCall = prisma.booking.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.cancelledAt).toBeInstanceOf(Date);
    });

    it('reserva CONFIRMED cancelada restaura availableQuantity (re-leitura dentro da tx)', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        freshEquipment: { availableQuantity: 0, quantity: 1 },
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(prisma.equipment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: EQUIPMENT_ID } }),
      );
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { availableQuantity: 1, isAvailable: true },
      });
    });

    it('não excede quantity ao restaurar unidades', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        freshEquipment: { availableQuantity: 1, quantity: 1 },
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { availableQuantity: 1, isAvailable: true },
      });
    });

    // Liquidação financeira (política D2)

    it('payment PENDING → marca FAILED sem ledger nem payout', async () => {
      setupCancelTx({
        booking: makeBooking({
          status: BookingStatus.PENDING,
          payment: { id: PAYMENT_ID, status: PaymentStatus.PENDING },
        }),
        freshPayment: makeFreshPayment({ status: PaymentStatus.PENDING }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: { status: PaymentStatus.FAILED },
      });
      expect(ledger.record).not.toHaveBeenCalled();
      expect(ledger.recordMany).not.toHaveBeenCalled();
      expect(payouts.createPending).not.toHaveBeenCalled();
    });

    it('payment HELD com cancelamento dentro da janela livre → reembolso total ao cliente', async () => {
      // startDate a 5 dias (> CANCELLATION_FREE_WINDOW_HOURS) → sem retenção
      setupCancelTx({
        booking: makeBooking({
          status: BookingStatus.CONFIRMED,
          payment: { id: PAYMENT_ID, status: PaymentStatus.HELD },
        }),
        freshPayment: makeFreshPayment(),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(ledger.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 1600,
          actorId: CLIENT_ID,
        }),
      );
      expect(payouts.createPending).toHaveBeenCalledTimes(1);
      expect(payouts.createPending).toHaveBeenCalledWith(prisma, {
        paymentId: PAYMENT_ID,
        recipientId: CLIENT_ID,
        kind: PayoutKind.CLIENT_REFUND,
        amount: 1600,
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({
          status: PaymentStatus.REFUNDED,
          refundAmount: 1600,
          ownerPayout: 0,
          depositStatus: DepositStatus.RETURNED,
        }),
      });
    });

    it('payment HELD sem depósito retido → não mexe no depositStatus', async () => {
      setupCancelTx({
        booking: makeBooking({
          status: BookingStatus.CONFIRMED,
          payment: { id: PAYMENT_ID, status: PaymentStatus.HELD },
        }),
        freshPayment: makeFreshPayment({ depositStatus: DepositStatus.NONE }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      const updateData = (
        prisma.payment.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(updateData.status).toBe(PaymentStatus.REFUNDED);
      expect(updateData).not.toHaveProperty('depositStatus');
    });

    it('cancelamento tardio do CLIENTE (< 48h) retém 30% do rental: 1000 → 300/30/270 e reembolso de totalCharged−300', async () => {
      // Exemplo canónico: rental 1000, totalCharged 1600 (rental+deposito 500+fee 100)
      // retained = 300, platformCut = 30, providerCompensation = 270, clientRefund = 1300
      const lateBooking = makeBooking({
        status: BookingStatus.CONFIRMED,
        startDate: hoursFromNow(CANCELLATION_FREE_WINDOW_HOURS / 2),
        endDate: hoursFromNow(CANCELLATION_FREE_WINDOW_HOURS / 2 + 72),
        payment: { id: PAYMENT_ID, status: PaymentStatus.HELD },
      });
      setupCancelTx({
        booking: lateBooking,
        freshPayment: makeFreshPayment({
          totalCharged: new Prisma.Decimal(1600),
          rentalAmount: new Prisma.Decimal(1000),
        }),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(ledger.recordMany).toHaveBeenCalledWith(prisma, [
        expect.objectContaining({
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 1300,
        }),
        expect.objectContaining({
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PROVIDER,
          amount: 270,
        }),
        expect.objectContaining({
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PLATFORM,
          amount: 30,
        }),
      ]);
      expect(payouts.createPending).toHaveBeenCalledTimes(2);
      expect(payouts.createPending).toHaveBeenNthCalledWith(1, prisma, {
        paymentId: PAYMENT_ID,
        recipientId: CLIENT_ID,
        kind: PayoutKind.CLIENT_REFUND,
        amount: 1300,
      });
      expect(payouts.createPending).toHaveBeenNthCalledWith(2, prisma, {
        paymentId: PAYMENT_ID,
        recipientId: OWNER_ID,
        kind: PayoutKind.PROVIDER_PAYOUT,
        amount: 270,
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({
          status: PaymentStatus.PARTIALLY_REFUNDED,
          refundAmount: 1300,
          ownerPayout: 270,
          depositStatus: DepositStatus.RETURNED,
        }),
      });
    });

    it('PROVIDER que cancela a menos de 48h NÃO sofre retenção — reembolso total ao cliente', async () => {
      const lateBooking = makeBooking({
        status: BookingStatus.CONFIRMED,
        startDate: hoursFromNow(CANCELLATION_FREE_WINDOW_HOURS / 2),
        endDate: hoursFromNow(CANCELLATION_FREE_WINDOW_HOURS / 2 + 72),
        payment: { id: PAYMENT_ID, status: PaymentStatus.HELD },
      });
      setupCancelTx({
        booking: lateBooking,
        user: makeUser(OWNER_ID, UserRole.PROVIDER),
        freshPayment: makeFreshPayment(),
      });

      await service.cancel(OWNER_ID, BOOKING_ID, {});

      expect(ledger.recordMany).not.toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          party: LedgerParty.CLIENT,
          amount: 1600,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({
          status: PaymentStatus.REFUNDED,
          refundAmount: 1600,
          ownerPayout: 0,
        }),
      });
    });

    // Strikes ao provider (política D2)

    it('PROVIDER que cancela reserva CONFIRMED recebe strike e audit PROVIDER_STRIKE_ISSUED', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        user: makeUser(OWNER_ID, UserRole.PROVIDER),
        strikeCount: 1,
      });

      await service.cancel(OWNER_ID, BOOKING_ID, {});

      expect(prisma.providerStrike.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: OWNER_ID,
          bookingId: BOOKING_ID,
        }),
      });
      expect(prisma.providerStrike.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: OWNER_ID }),
      });
      // Abaixo do limite → sem suspensão
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.equipment.updateMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PROVIDER_STRIKE_ISSUED,
          actorId: OWNER_ID,
          targetType: 'User',
          targetId: OWNER_ID,
        }),
      );
    });

    it('ao 3º strike suspende as listagens do provider', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        user: makeUser(OWNER_ID, UserRole.PROVIDER),
        strikeCount: PROVIDER_STRIKE_LIMIT,
      });

      await service.cancel(OWNER_ID, BOOKING_ID, {});

      const userUpdate = prisma.user.update.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(userUpdate.where).toEqual({ id: OWNER_ID });
      expect(userUpdate.data.listingsSuspendedUntil).toBeInstanceOf(Date);
      expect(prisma.equipment.updateMany).toHaveBeenCalledWith({
        where: { ownerId: OWNER_ID, status: EquipmentStatus.ACTIVE },
        data: { isAvailable: false },
      });
    });

    it('ADMIN que cancela reserva CONFIRMED não gera strike', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        user: makeUser(ADMIN_ID, UserRole.ADMIN),
      });

      await service.cancel(ADMIN_ID, BOOKING_ID, {});

      expect(prisma.providerStrike.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('CLIENTE que cancela reserva CONFIRMED não gera strike', async () => {
      setupCancelTx({
        booking: makeBooking({ status: BookingStatus.CONFIRMED }),
        user: makeUser(CLIENT_ID, UserRole.CLIENT),
      });

      await service.cancel(CLIENT_ID, BOOKING_ID, {});

      expect(prisma.providerStrike.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // complete() — checkpoint 2 do escrow (devolução confirmada pelo provider)

  describe('complete()', () => {
    const makeActiveBooking = (
      overrides: Partial<Record<string, unknown>> = {},
    ) =>
      makeBooking({
        status: BookingStatus.ACTIVE,
        equipment: {
          id: EQUIPMENT_ID,
          title: 'Betoneira 300L',
          availableQuantity: 0,
          quantity: 1,
        },
        payment: makeDepositPayment(),
        ...overrides,
      });

    const completedBooking = makeBooking({
      status: BookingStatus.COMPLETED,
      returnConfirmedAt: new Date(),
    });

    /** Configura o fluxo completo dentro da transacção do complete. */
    const setupCompleteTx = ({
      booking = makeActiveBooking(),
      user = makeUser(OWNER_ID, UserRole.PROVIDER),
      freshPayment = makeDepositPayment() as unknown,
      freshEquipment = { availableQuantity: 0, quantity: 1 } as unknown,
    } = {}) => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(booking) // leitura externa (include)
        .mockResolvedValueOnce({ status: booking.status }); // re-leitura na tx (select)
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.booking.update.mockResolvedValue(completedBooking);
      prisma.equipment.findUnique.mockResolvedValue(freshEquipment);
      prisma.equipment.update.mockResolvedValue({});
      prisma.payment.findUnique.mockResolvedValue(freshPayment);
      prisma.payment.update.mockResolvedValue({});
      useRealTransaction();
    };

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.complete(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeActiveBooking());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.complete(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT não pode concluir — recebe ForbiddenException', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeActiveBooking());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.complete(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para concluir esta reserva.',
        ),
      );
    });

    it('exige reserva ACTIVE — CONFIRMED lança BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeActiveBooking({ status: BookingStatus.CONFIRMED }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.complete(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas ativas (entrega confirmada) podem ser concluídas.',
        ),
      );
    });

    it('re-leitura na transacção: reserva já não está ACTIVE → BadRequestException', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce(makeActiveBooking())
        .mockResolvedValueOnce({ status: BookingStatus.COMPLETED });
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      useRealTransaction();

      await expect(service.complete(OWNER_ID, BOOKING_ID)).rejects.toThrow(
        new BadRequestException(
          'Apenas reservas ativas (entrega confirmada) podem ser concluídas.',
        ),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('OWNER conclui reserva ACTIVE: COMPLETED + returnConfirmedAt e restaura o equipamento', async () => {
      setupCompleteTx();

      const result = await service.complete(OWNER_ID, BOOKING_ID);

      expect(result.message).toBe(
        'Devolução confirmada e reserva concluída com sucesso.',
      );
      const updateCall = prisma.booking.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.status).toBe(BookingStatus.COMPLETED);
      expect(updateCall.data.returnConfirmedAt).toBeInstanceOf(Date);
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: EQUIPMENT_ID },
        data: { availableQuantity: 1, isAvailable: true },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.BOOKING_RETURN_CONFIRMED,
          actorId: OWNER_ID,
          targetType: 'Booking',
          targetId: BOOKING_ID,
        }),
      );
    });

    it('devolve o depósito quando payment RELEASED e depósito HELD', async () => {
      setupCompleteTx({
        freshPayment: makeDepositPayment({
          depositAmount: new Prisma.Decimal(1000),
        }),
      });

      await service.complete(OWNER_ID, BOOKING_ID);

      expect(ledger.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 1000,
          actorId: OWNER_ID,
        }),
      );
      expect(payouts.createPending).toHaveBeenCalledWith(prisma, {
        paymentId: PAYMENT_ID,
        recipientId: CLIENT_ID,
        kind: PayoutKind.DEPOSIT_RETURN,
        amount: 1000,
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({
          depositStatus: DepositStatus.RETURNED,
        }),
      });
    });

    it('NÃO devolve o depósito se o payment não está RELEASED', async () => {
      setupCompleteTx({
        freshPayment: makeDepositPayment({ status: PaymentStatus.HELD }),
      });

      await service.complete(OWNER_ID, BOOKING_ID);

      expect(ledger.record).not.toHaveBeenCalled();
      expect(payouts.createPending).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('NÃO devolve o depósito se o depósito não está HELD', async () => {
      setupCompleteTx({
        freshPayment: makeDepositPayment({
          depositStatus: DepositStatus.RETURNED,
        }),
      });

      await service.complete(OWNER_ID, BOOKING_ID);

      expect(ledger.record).not.toHaveBeenCalled();
      expect(payouts.createPending).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('conclui sem tocar no escrow quando a reserva não tem pagamento', async () => {
      setupCompleteTx({
        booking: makeActiveBooking({ payment: null }),
        freshPayment: null,
      });

      const result = await service.complete(OWNER_ID, BOOKING_ID);

      expect(result.message).toBe(
        'Devolução confirmada e reserva concluída com sucesso.',
      );
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
      expect(ledger.record).not.toHaveBeenCalled();
    });

    it('ADMIN pode concluir', async () => {
      setupCompleteTx({ user: makeUser(ADMIN_ID, UserRole.ADMIN) });

      const result = await service.complete(ADMIN_ID, BOOKING_ID);
      expect(result.message).toBe(
        'Devolução confirmada e reserva concluída com sucesso.',
      );
    });
  });

  // autoReturnDepositsDue() — auto-devolução do depósito (scheduler D1)

  describe('autoReturnDepositsDue()', () => {
    const completeResult = {
      message: 'Devolução confirmada e reserva concluída com sucesso.',
      data: {},
    } as unknown as Awaited<ReturnType<BookingsService['complete']>>;

    it('devolve 0 quando não há reservas devidas', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      const completeSpy = jest.spyOn(service, 'complete');

      const result = await service.autoReturnDepositsDue();

      expect(result).toBe(0);
      expect(completeSpy).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('conclui cada reserva devida em nome do owner e regista DEPOSIT_AUTO_RETURNED', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { id: 'booking-1', ownerId: OWNER_ID },
        { id: 'booking-2', ownerId: 'owner-uuid-002' },
      ]);
      const completeSpy = jest
        .spyOn(service, 'complete')
        .mockResolvedValue(completeResult);

      const result = await service.autoReturnDepositsDue();

      expect(result).toBe(2);
      expect(completeSpy).toHaveBeenNthCalledWith(1, OWNER_ID, 'booking-1');
      expect(completeSpy).toHaveBeenNthCalledWith(
        2,
        'owner-uuid-002',
        'booking-2',
      );
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DEPOSIT_AUTO_RETURNED,
          actorId: OWNER_ID,
          targetType: 'Booking',
          targetId: 'booking-1',
        }),
      );

      // O filtro só apanha reservas ACTIVE, sem disputa e com payment RELEASED
      const whereArg = (
        prisma.booking.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({
        status: BookingStatus.ACTIVE,
        dispute: null,
        payment: { status: PaymentStatus.RELEASED },
      });
    });

    it('falha num item não trava o processamento dos restantes', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { id: 'booking-1', ownerId: OWNER_ID },
        { id: 'booking-2', ownerId: OWNER_ID },
      ]);
      const completeSpy = jest
        .spyOn(service, 'complete')
        .mockRejectedValueOnce(new Error('Disputa aberta entretanto'))
        .mockResolvedValueOnce(completeResult);

      const result = await service.autoReturnDepositsDue();

      expect(result).toBe(1);
      expect(completeSpy).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DEPOSIT_AUTO_RETURNED,
          targetId: 'booking-2',
        }),
      );
    });
  });
});
