import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditAction,
  BookingStatus,
  DepositStatus,
  DisputeStatus,
  LedgerDirection,
  LedgerParty,
  PaymentMethod,
  PaymentStatus,
  PayoutKind,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { AuditService } from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CollectionsService } from './collections.service';
import { EscrowRefundService } from './escrow-refund.service';
import { LedgerService } from './ledger.service';
import { PaymentNotifier } from './payment-notifier.service';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';

const auditMock = { record: jest.fn() };
const metricsMock = { businessEvents: { inc: jest.fn() } };
const ledgerMock = {
  record: jest.fn(),
  recordMany: jest.fn(),
  balance: jest.fn(),
};
const payoutsMock = { createPending: jest.fn() };
const notifierMock = {
  held: jest.fn(),
  released: jest.fn(),
  autoReleaseReminder: jest.fn(),
};
const collectionsMock = {
  confirmByAdmin: jest.fn(),
  confirmSimulated: jest.fn(),
};

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const THIRD_ID = 'third-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const SERVICE_BOOKING_ID = 'service-booking-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const DISPUTE_ID = 'dispute-uuid-001';

// O que o admin lê no extracto M-Pesa. O valor é o total de makePayment().
const HELD_RECEIPT = {
  mpesaReference: 'CHK7H3ABCD',
  receivedAmount: 2700,
  payerMsisdn: '+258840000002',
};

const makeUser = (id: string, role: UserRole) => ({
  id,
  name: role,
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

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  equipmentId: 'equip-uuid-001',
  startDate: new Date('2030-06-01'),
  endDate: new Date('2030-06-05'),
  totalDays: 4,
  rentalAmount: new Prisma.Decimal(2000),
  depositAmount: new Prisma.Decimal(500),
  platformFee: new Prisma.Decimal(200),
  totalAmount: new Prisma.Decimal(2700),
  status: BookingStatus.CONFIRMED,
  deliveryAddress: null,
  clientNote: null,
  confirmedAt: new Date(),
  cancelledAt: null,
  cancellationReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  equipment: {
    id: 'equip-uuid-001',
    title: 'Betoneira',
    location: 'Maputo',
    status: 'ACTIVE',
    isAvailable: true,
  },
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  payment: null,
  disputes: [],
  ...overrides,
});

const makePayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  bookingId: BOOKING_ID,
  serviceBookingId: null,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  rentalAmount: new Prisma.Decimal(2000),
  depositAmount: new Prisma.Decimal(500),
  platformFee: new Prisma.Decimal(200),
  totalCharged: new Prisma.Decimal(2700),
  ownerPayout: new Prisma.Decimal(1800),
  currency: 'MZN',
  method: PaymentMethod.MPESA,
  mpesaReference: null,
  status: PaymentStatus.PENDING,
  depositStatus: DepositStatus.NONE,
  heldAt: null,
  releasedAt: null,
  refundedAt: null,
  refundAmount: null,
  depositReleasedAt: null,
  depositHeldAmount: new Prisma.Decimal(500),
  receiptNumber: 'ZUNO-1234567890-00001',
  createdAt: new Date(),
  updatedAt: new Date(),
  booking: {
    id: BOOKING_ID,
    startDate: new Date('2030-06-01'),
    endDate: new Date('2030-06-05'),
    status: BookingStatus.CONFIRMED,
    ownerId: OWNER_ID,
  },
  serviceBooking: null,
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  disputes: [],
  ...overrides,
});

const makePrisma = () => ({
  user: {
    findUnique: jest.fn(),
  },
  booking: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  serviceBooking: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: ReturnType<typeof makePrisma>;

  // Faz o $transaction interactivo executar o callback com o próprio mock
  // do prisma a servir de TransactionClient.
  const runTransaction = () =>
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
    );

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        EscrowRefundService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditMock },
        { provide: MetricsService, useValue: metricsMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: PayoutsService, useValue: payoutsMock },
        { provide: PaymentNotifier, useValue: notifierMock },
        { provide: CollectionsService, useValue: collectionsMock },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // initiate()

  describe('initiate()', () => {
    const dto = { method: PaymentMethod.MPESA };

    it('cria o pagamento com sucesso e devolve os dados formatados', async () => {
      const booking = makeBooking();
      const payment = makePayment();

      prisma.booking.findUnique.mockResolvedValue(booking);
      prisma.payment.findUnique.mockResolvedValueOnce(null); // receiptNumber único — tentativa 1
      prisma.payment.create.mockResolvedValue(payment);

      const result = await service.initiate(CLIENT_ID, BOOKING_ID, dto);

      expect(result.message).toBe('Pagamento iniciado com sucesso.');
      expect(result.data.status).toBe(PaymentStatus.PENDING);
      expect(result.data.currency).toBe('MZN');
      expect(result.data.method).toBe(PaymentMethod.MPESA);
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });

    it('calcula ownerPayout correctamente (rentalAmount - platformFee)', async () => {
      const booking = makeBooking();
      const payment = makePayment();

      prisma.booking.findUnique.mockResolvedValue(booking);
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue(payment);

      await service.initiate(CLIENT_ID, BOOKING_ID, dto);

      const createCall = prisma.payment.create.mock.calls[0][0];
      expect(createCall.data.ownerPayout).toBe(1800);
    });

    it('lança NotFoundException se a reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.initiate(CLIENT_ID, BOOKING_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('lança ForbiddenException se quem chama não é o cliente da reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      await expect(service.initiate(OWNER_ID, BOOKING_ID, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança BadRequestException se a reserva não está CONFIRMED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.PENDING }),
      );

      await expect(
        service.initiate(CLIENT_ID, BOOKING_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequestException se a reserva tem disputa associada', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          disputes: [{ id: DISPUTE_ID, status: DisputeStatus.OPEN }],
        }),
      );

      await expect(
        service.initiate(CLIENT_ID, BOOKING_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequestException se já existe pagamento para esta reserva', async () => {
      const existingPayment = makePayment();
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ payment: existingPayment }),
      );

      await expect(
        service.initiate(CLIENT_ID, BOOKING_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenta gerar receiptNumber único até 5 vezes antes de lançar erro', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.payment.findUnique.mockResolvedValue(makePayment());

      await expect(
        service.initiate(CLIENT_ID, BOOKING_ID, dto),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.payment.findUnique).toHaveBeenCalledTimes(5);
    });

    it('usa o receiptNumber da segunda tentativa quando a primeira colide', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      const payment = makePayment();

      prisma.payment.findUnique
        .mockResolvedValueOnce(makePayment()) // primeira tentativa: colide
        .mockResolvedValueOnce(null); // segunda tentativa: livre
      prisma.payment.create.mockResolvedValue(payment);

      const result = await service.initiate(CLIENT_ID, BOOKING_ID, dto);

      expect(result.message).toBe('Pagamento iniciado com sucesso.');
      expect(prisma.payment.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  // findMyPayments()

  describe('findMyPayments()', () => {
    const query = { page: 1, limit: 10 };

    it('lança NotFoundException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findMyPayments(CLIENT_ID, query)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('CLIENT vê apenas os seus próprios pagamentos (filtra por clientId ou ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.payment.findMany.mockResolvedValue([makePayment()]);
      prisma.payment.count.mockResolvedValue(1);

      await service.findMyPayments(CLIENT_ID, query);

      const whereArg = prisma.payment.findMany.mock.calls[0][0].where;
      expect(whereArg).toHaveProperty('OR');
      expect(whereArg.OR).toContainEqual({ clientId: CLIENT_ID });
      expect(whereArg.OR).toContainEqual({ ownerId: CLIENT_ID });
      expect(whereArg.OR).not.toContainEqual({ providerId: CLIENT_ID });
    });

    it('ADMIN vê todos os pagamentos (sem filtro OR)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findMany.mockResolvedValue([makePayment()]);
      prisma.payment.count.mockResolvedValue(1);

      await service.findMyPayments(ADMIN_ID, query);

      const whereArg = prisma.payment.findMany.mock.calls[0][0].where;
      expect(whereArg).not.toHaveProperty('OR');
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.payment.findMany.mockResolvedValue([makePayment()]);
      prisma.payment.count.mockResolvedValue(25);

      const result = await service.findMyPayments(CLIENT_ID, {
        page: 2,
        limit: 10,
      });

      expect(result.meta.page).toBe(2);
      expect(result.meta.total).toBe(25);
      expect(result.meta.totalPages).toBe(3);
      expect(result.meta.hasNextPage).toBe(true);
      expect(result.meta.hasPreviousPage).toBe(true);
    });

    it('filtra por status quando fornecido na query', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.findMyPayments(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: PaymentStatus.HELD,
      });

      const whereArg = prisma.payment.findMany.mock.calls[0][0].where;
      expect(whereArg).toMatchObject({ status: PaymentStatus.HELD });
    });
  });

  // findOne()

  describe('findOne()', () => {
    it('lança NotFoundException se o pagamento não existe', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.findOne(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança NotFoundException se o utilizador não existe', async () => {
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    describe('o número de onde saiu o dinheiro', () => {
      const PAYER_NUMBER = '+258840000003';
      const collectionSeenBy = async (userId: string, role: UserRole) => {
        prisma.payment.findUnique.mockResolvedValue(
          makePayment({
            providerOperations: [
              {
                id: 'operacao-1',
                provider: 'manual',
                status: 'CONFIRMED',
                amount: new Prisma.Decimal(2700),
                msisdn: PAYER_NUMBER,
                failureCode: null,
                failureReason: null,
                createdAt: new Date(),
                confirmedAt: new Date(),
              },
            ],
          }),
        );
        prisma.user.findUnique.mockResolvedValue(makeUser(userId, role));

        const { data } = await service.findOne(userId, PAYMENT_ID);
        return data.collection;
      };

      it('chega ao cliente que pagou', async () => {
        const collection = await collectionSeenBy(CLIENT_ID, UserRole.CLIENT);

        expect(collection?.msisdn).toBe(PAYER_NUMBER);
      });

      it('chega a um admin', async () => {
        const collection = await collectionSeenBy(ADMIN_ID, UserRole.ADMIN);

        expect(collection?.msisdn).toBe(PAYER_NUMBER);
      });

      it('não chega ao provider, que vê o resto da cobrança', async () => {
        const collection = await collectionSeenBy(OWNER_ID, UserRole.PROVIDER);

        expect(collection).toMatchObject({ status: 'CONFIRMED', msisdn: null });
      });
    });

    it('diz em que estado está o depósito e a que reserva de serviço pertence', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          bookingId: null,
          serviceBookingId: 'reserva-de-servico-1',
          depositStatus: DepositStatus.HELD,
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      const { data } = await service.findOne(CLIENT_ID, PAYMENT_ID);

      expect(data).toMatchObject({
        bookingId: null,
        serviceBookingId: 'reserva-de-servico-1',
        depositStatus: DepositStatus.HELD,
      });
    });

    it('CLIENT pode ver o seu próprio pagamento', async () => {
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      const result = await service.findOne(CLIENT_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento obtido com sucesso.');
    });

    it('OWNER pode ver o pagamento do seu equipamento', async () => {
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      const result = await service.findOne(OWNER_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento obtido com sucesso.');
    });

    it('ADMIN pode ver qualquer pagamento', async () => {
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );

      const result = await service.findOne(ADMIN_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento obtido com sucesso.');
    });

    it('terceiro sem relação com o pagamento recebe ForbiddenException', async () => {
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(THIRD_ID, UserRole.CLIENT),
      );

      await expect(service.findOne(THIRD_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // markHeld()

  describe('markHeld()', () => {
    // A entrada do dinheiro em si (ledger, depósito, valor, referência) vive
    // no CollectionsService e é testada em collections.service.spec.ts. Aqui
    // fica o que o PaymentsService decide antes e depois dela.
    const pendingPayment = (overrides: Record<string, unknown> = {}) =>
      makePayment({
        status: PaymentStatus.PENDING,
        booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
        disputes: [],
        ...overrides,
      });

    const setupAdmin = (payment = pendingPayment()) => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.payment.findUniqueOrThrow.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
          depositStatus: DepositStatus.HELD,
          heldAt: new Date(),
        }),
      );
      collectionsMock.confirmByAdmin.mockResolvedValue({
        held: true,
        excess: 0,
      });
    };

    const markHeldError = async (): Promise<ApiException> => {
      try {
        await service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT);
      } catch (error) {
        return error as ApiException;
      }
      throw new Error('O mark-held devia ter sido recusado.');
    };

    it('ADMIN confirma pelo caminho único das cobranças, com o que leu no extracto', async () => {
      setupAdmin();

      const result = await service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT);

      expect(result.message).toBe('Pagamento marcado como retido com sucesso.');
      expect(result.data.status).toBe(PaymentStatus.HELD);
      expect(collectionsMock.confirmByAdmin).toHaveBeenCalledWith(
        ADMIN_ID,
        PAYMENT_ID,
        HELD_RECEIPT,
      );
    });

    it('avisa as duas partes de que o pagamento foi confirmado', async () => {
      setupAdmin();

      await service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT);

      expect(notifierMock.held).toHaveBeenCalledWith(PAYMENT_ID);
    });

    it('não avisa ninguém quando a confirmação é recusada', async () => {
      setupAdmin();
      collectionsMock.confirmByAdmin.mockRejectedValue(
        new BadRequestException('Valor a menos.'),
      );

      await expect(
        service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(BadRequestException);

      expect(notifierMock.held).not.toHaveBeenCalled();
    });

    it.each([
      ['cliente', { clientId: ADMIN_ID }],
      ['dono', { ownerId: ADMIN_ID }],
    ])('recusa a um admin que é o %s da reserva', async (_role, parties) => {
      setupAdmin(pendingPayment(parties));

      const error = await markHeldError();

      expect(error.getStatus()).toBe(403);
      expect(error.errorCode).toBe(ErrorCode.MONEY_CONTROL_VIOLATION);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });

    it('CLIENT não pode marcar como retido — recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(
        service.markHeld(CLIENT_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(ForbiddenException);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });

    it('OWNER não pode marcar como retido — recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(
        service.markHeld(OWNER_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(ForbiddenException);
    });

    it('utilizador inexistente recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.markHeld(CLIENT_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lança NotFoundException se o pagamento não existe', async () => {
      setupAdmin();
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(NotFoundException);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se o pagamento já não está PENDING', async () => {
      setupAdmin(pendingPayment({ status: PaymentStatus.HELD }));

      await expect(
        service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(BadRequestException);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se a reserva está CANCELLED', async () => {
      setupAdmin(
        pendingPayment({
          booking: { id: BOOKING_ID, status: BookingStatus.CANCELLED },
        }),
      );

      await expect(
        service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(BadRequestException);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se há disputa associada', async () => {
      setupAdmin(
        pendingPayment({
          disputes: [{ id: DISPUTE_ID, status: DisputeStatus.OPEN }],
        }),
      );

      await expect(
        service.markHeld(ADMIN_ID, PAYMENT_ID, HELD_RECEIPT),
      ).rejects.toThrow(BadRequestException);
      expect(collectionsMock.confirmByAdmin).not.toHaveBeenCalled();
    });
  });

  // release()  ← O MAIS CRÍTICO - protege o escrow (checkpoint 1: entrega)

  describe('release()', () => {
    const heldPayment = (overrides: Record<string, unknown> = {}) =>
      makePayment({
        status: PaymentStatus.HELD,
        depositStatus: DepositStatus.HELD,
        booking: {
          id: BOOKING_ID,
          status: BookingStatus.CONFIRMED,
          ownerId: OWNER_ID,
        },
        ...overrides,
      });

    // Re-leitura feita DENTRO da transacção (select reduzido com dispute).
    const freshHeld = (overrides: Record<string, unknown> = {}) => ({
      status: PaymentStatus.HELD,
      totalCharged: new Prisma.Decimal(2700),
      depositAmount: new Prisma.Decimal(500),
      ownerPayout: new Prisma.Decimal(1800),
      ownerId: OWNER_ID,
      disputes: [],
      ...overrides,
    });

    const releasedPayment = () =>
      makePayment({
        status: PaymentStatus.RELEASED,
        depositStatus: DepositStatus.HELD,
        releasedAt: new Date(),
        booking: {
          id: BOOKING_ID,
          startDate: new Date('2030-06-01'),
          endDate: new Date('2030-06-05'),
          status: BookingStatus.ACTIVE,
        },
      });

    const setupHappyPath = ({
      payment = heldPayment(),
      fresh = freshHeld(),
      userId = CLIENT_ID,
      role = UserRole.CLIENT,
    }: {
      payment?: ReturnType<typeof makePayment>;
      fresh?: ReturnType<typeof freshHeld>;
      userId?: string;
      role?: UserRole;
    } = {}) => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(payment) // pré-check (include)
        .mockResolvedValueOnce(fresh); // re-leitura na transacção (select)
      prisma.user.findUnique.mockResolvedValue(makeUser(userId, role));
      prisma.booking.update.mockResolvedValue({});
      prisma.serviceBooking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(releasedPayment());
      runTransaction();
    };

    it('CLIENT libera o pagamento HELD com sucesso — usa $transaction', async () => {
      setupHappyPath();

      const result = await service.release(CLIENT_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento liberado com sucesso.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('ADMIN pode liberar o pagamento HELD', async () => {
      setupHappyPath({ userId: ADMIN_ID, role: UserRole.ADMIN });

      const result = await service.release(ADMIN_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento liberado com sucesso.');
    });

    // CHECKPOINT 1 (D1): a reserva fica ACTIVE (equipamento com o cliente),
    // NUNCA COMPLETED — o ciclo só fecha na devolução (checkpoint 2).
    it('a transacção põe a reserva ACTIVE com deliveryConfirmedAt e o payment RELEASED', async () => {
      setupHappyPath();

      await service.release(CLIENT_ID, PAYMENT_ID);

      const bookingUpdate = prisma.booking.update.mock.calls[0][0];
      expect(bookingUpdate.data.status).toBe(BookingStatus.ACTIVE);
      expect(bookingUpdate.data.status).not.toBe(BookingStatus.COMPLETED);
      expect(bookingUpdate.data.deliveryConfirmedAt).toBeInstanceOf(Date);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.RELEASED }),
        }),
      );
    });

    // CRÍTICO: o depósito continua retido no checkpoint 1.
    it('com depósito, o depositStatus NÃO é tocado no release (continua HELD)', async () => {
      setupHappyPath();

      await service.release(CLIENT_ID, PAYMENT_ID);

      const updateCall = prisma.payment.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(PaymentStatus.RELEASED);
      expect(updateCall.data).not.toHaveProperty('depositStatus');
      expect(updateCall.data).not.toHaveProperty('depositReleasedAt');
    });

    it('sem depósito, o depositStatus passa a NONE com depositReleasedAt', async () => {
      setupHappyPath({
        fresh: freshHeld({
          depositAmount: new Prisma.Decimal(0),
          totalCharged: new Prisma.Decimal(2200),
        }),
      });

      await service.release(CLIENT_ID, PAYMENT_ID);

      const updateCall = prisma.payment.update.mock.calls[0][0];
      expect(updateCall.data.depositStatus).toBe(DepositStatus.NONE);
      expect(updateCall.data.depositReleasedAt).toBeInstanceOf(Date);
    });

    // CRÍTICO: valores exactos dos movimentos contabilísticos.
    it('regista OUTFLOW PROVIDER (ownerPayout) e OUTFLOW PLATFORM (fee) no ledger', async () => {
      setupHappyPath();

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(ledgerMock.record).toHaveBeenCalledTimes(2);
      expect(ledgerMock.record).toHaveBeenNthCalledWith(
        1,
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PROVIDER,
          amount: 1800,
          actorId: CLIENT_ID,
        }),
      );
      // platformTake = 2700 (total) − 500 (depósito) − 1800 (payout) = 400
      expect(ledgerMock.record).toHaveBeenNthCalledWith(
        2,
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PLATFORM,
          amount: 400,
        }),
      );
    });

    it('não regista OUTFLOW PLATFORM quando a fee da plataforma é zero', async () => {
      setupHappyPath({
        fresh: freshHeld({
          // 2300 − 500 − 1800 = 0 → sem movimento PLATFORM
          totalCharged: new Prisma.Decimal(2300),
        }),
      });

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ party: LedgerParty.PROVIDER }),
      );
    });

    it('cria payout PENDING do tipo PROVIDER_PAYOUT para o provider', async () => {
      setupHappyPath();

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(payoutsMock.createPending).toHaveBeenCalledTimes(1);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(prisma, {
        paymentId: PAYMENT_ID,
        recipientId: OWNER_ID,
        kind: PayoutKind.PROVIDER_PAYOUT,
        amount: 1800,
      });
    });

    it('incrementa a métrica de negócio payment_released', async () => {
      setupHappyPath();

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(metricsMock.businessEvents.inc).toHaveBeenCalledWith({
        event: 'payment_released',
      });
    });

    it('em serviços: serviceBooking vai para COMPLETED e depositStatus fica NONE', async () => {
      setupHappyPath({
        payment: makePayment({
          status: PaymentStatus.HELD,
          booking: null,
          serviceBooking: {
            id: SERVICE_BOOKING_ID,
            status: ServiceBookingStatus.IN_PROGRESS,
            providerId: OWNER_ID,
          },
        }),
        fresh: freshHeld({
          depositAmount: new Prisma.Decimal(0),
          totalCharged: new Prisma.Decimal(2200),
        }),
      });
      prisma.serviceBooking.findUnique.mockResolvedValue({
        status: ServiceBookingStatus.IN_PROGRESS,
        completedAt: null,
      });

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(prisma.booking.update).not.toHaveBeenCalled();
      const sbUpdate = prisma.serviceBooking.update.mock.calls[0][0];
      expect(sbUpdate.data.status).toBe(ServiceBookingStatus.COMPLETED);
      expect(sbUpdate.data.completedAt).toBeInstanceOf(Date);

      const updateCall = prisma.payment.update.mock.calls[0][0];
      expect(updateCall.data.depositStatus).toBe(DepositStatus.NONE);
    });

    it('em serviços: fica a data em que o provider deu o serviço por concluído', async () => {
      const completedAt = new Date('2030-06-01T10:00:00.000Z');
      setupHappyPath({
        payment: makePayment({
          status: PaymentStatus.HELD,
          booking: null,
          serviceBooking: {
            id: SERVICE_BOOKING_ID,
            status: ServiceBookingStatus.COMPLETED,
            providerId: OWNER_ID,
          },
        }),
        fresh: freshHeld({ depositAmount: new Prisma.Decimal(0) }),
      });
      prisma.serviceBooking.findUnique.mockResolvedValue({
        status: ServiceBookingStatus.COMPLETED,
        completedAt,
      });

      await service.release(CLIENT_ID, PAYMENT_ID);

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith({
        where: { id: SERVICE_BOOKING_ID },
        data: { status: ServiceBookingStatus.COMPLETED, completedAt },
      });
    });

    it('em serviços: recusa se a reserva foi cancelada entretanto, relida dentro da transacção', async () => {
      setupHappyPath({
        payment: makePayment({
          status: PaymentStatus.HELD,
          booking: null,
          serviceBooking: {
            id: SERVICE_BOOKING_ID,
            status: ServiceBookingStatus.IN_PROGRESS,
            providerId: OWNER_ID,
          },
        }),
        fresh: freshHeld({ depositAmount: new Prisma.Decimal(0) }),
      });
      prisma.serviceBooking.findUnique.mockResolvedValue({
        status: ServiceBookingStatus.CANCELLED,
        completedAt: null,
      });

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(ledgerMock.record).not.toHaveBeenCalled();
    });

    // REGRA CENTRAL DO ESCROW

    it('OWNER NÃO pode liberar o seu próprio pagamento — ForbiddenException', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.release(OWNER_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('terceiro sem relação com o pagamento recebe ForbiddenException', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(THIRD_ID, UserRole.CLIENT),
      );

      await expect(service.release(THIRD_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança NotFoundException se o pagamento não existe', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança NotFoundException se o utilizador não existe', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança BadRequestException se o pagamento não está HELD', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({ status: PaymentStatus.PENDING }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se o pagamento já foi RELEASED', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({ status: PaymentStatus.RELEASED }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se a reserva não está CONFIRMED (PENDING)', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        heldPayment({
          booking: {
            id: BOOKING_ID,
            status: BookingStatus.PENDING,
            ownerId: OWNER_ID,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    // CRÍTICO: no contrato v2 a reserva ACTIVE já passou o checkpoint 1 —
    // um segundo release seria desembolso duplo.
    it('rejeita liberação quando a reserva está ACTIVE — BadRequestException', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        heldPayment({
          booking: {
            id: BOOKING_ID,
            status: BookingStatus.ACTIVE,
            ownerId: OWNER_ID,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(payoutsMock.createPending).not.toHaveBeenCalled();
    });

    it('rejeita liberação quando a reserva está COMPLETED — BadRequestException', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        heldPayment({
          booking: {
            id: BOOKING_ID,
            status: BookingStatus.COMPLETED,
            ownerId: OWNER_ID,
          },
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se existe disputa associada ao pagamento', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        heldPayment({
          disputes: [{ id: DISPUTE_ID, status: DisputeStatus.OPEN }],
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a re-leitura dentro da transacção detecta corrida: pagamento já não HELD', async () => {
      setupHappyPath({
        fresh: freshHeld({ status: PaymentStatus.RELEASED }),
      });

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(payoutsMock.createPending).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('a re-leitura dentro da transacção detecta disputa criada entretanto', async () => {
      setupHappyPath({
        fresh: freshHeld({ disputes: [{ id: DISPUTE_ID }] }),
      });

      await expect(service.release(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });

  // refund()

  describe('refund()', () => {
    const heldPayment = () =>
      makePayment({
        status: PaymentStatus.HELD,
        depositStatus: DepositStatus.HELD,
        booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
        disputes: [],
      });

    // Re-leitura feita DENTRO da transacção (select reduzido).
    const freshRefundable = (overrides: Record<string, unknown> = {}) => ({
      status: PaymentStatus.HELD,
      totalCharged: new Prisma.Decimal(2700),
      depositStatus: DepositStatus.HELD,
      clientId: CLIENT_ID,
      // Sem disputa aberta à hora da releitura.
      disputes: [],
      ...overrides,
    });

    const refundedPayment = () =>
      makePayment({
        status: PaymentStatus.REFUNDED,
        refundedAt: new Date(),
        refundAmount: new Prisma.Decimal(2700),
        booking: {
          id: BOOKING_ID,
          startDate: new Date('2030-06-01'),
          endDate: new Date('2030-06-05'),
          status: BookingStatus.CANCELLED,
        },
      });

    const setupHappyPath = (
      payment = heldPayment(),
      fresh = freshRefundable(),
    ) => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique
        .mockResolvedValueOnce(payment) // pré-check (include)
        .mockResolvedValueOnce(fresh); // re-leitura na transacção (select)
      prisma.booking.update.mockResolvedValue({});
      prisma.serviceBooking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(refundedPayment());
      // O que o refund devolve é o pagamento relido depois da devolução.
      prisma.payment.findUniqueOrThrow.mockResolvedValue(refundedPayment());
      runTransaction();
    };

    it('ADMIN reembolsa pagamento HELD com sucesso', async () => {
      setupHappyPath();

      const result = await service.refund(ADMIN_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento reembolsado com sucesso.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('reembolso de HELD regista OUTFLOW CLIENT no ledger e cria payout CLIENT_REFUND', async () => {
      setupHappyPath();

      await service.refund(ADMIN_ID, PAYMENT_ID);

      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 2700,
          actorId: ADMIN_ID,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(prisma, {
        paymentId: PAYMENT_ID,
        recipientId: CLIENT_ID,
        kind: PayoutKind.CLIENT_REFUND,
        amount: 2700,
      });
    });

    it('reembolso de HELD devolve o depósito: depositStatus RETURNED com depositReleasedAt', async () => {
      setupHappyPath();

      await service.refund(ADMIN_ID, PAYMENT_ID);

      const updateCall = prisma.payment.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(PaymentStatus.REFUNDED);
      expect(updateCall.data.depositStatus).toBe(DepositStatus.RETURNED);
      expect(updateCall.data.depositReleasedAt).toBeInstanceOf(Date);
    });

    describe('quando o dinheiro nunca entrou (pagamento PENDING)', () => {
      beforeEach(() => {
        setupHappyPath(
          makePayment({
            status: PaymentStatus.PENDING,
            booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
            disputes: [],
          }),
          freshRefundable({
            status: PaymentStatus.PENDING,
            depositStatus: DepositStatus.NONE,
          }),
        );
        prisma.payment.update.mockResolvedValue(
          makePayment({ status: PaymentStatus.FAILED, refundAmount: null }),
        );
      });

      it('anula o pagamento e cancela a reserva, sem ledger nem payout', async () => {
        const result = await service.refund(ADMIN_ID, PAYMENT_ID);

        expect(result.message).toContain('Pagamento anulado.');
        expect(prisma.booking.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
          }),
        );
        expect(ledgerMock.record).not.toHaveBeenCalled();
        expect(payoutsMock.createPending).not.toHaveBeenCalled();
      });

      it('deixa o pagamento FAILED, sem valor nem data de reembolso', async () => {
        await service.refund(ADMIN_ID, PAYMENT_ID);

        const updateCall = prisma.payment.update.mock.calls[0][0];
        expect(updateCall.data).toEqual({ status: PaymentStatus.FAILED });
      });

      it('regista em auditoria que não havia dinheiro a devolver', async () => {
        await service.refund(ADMIN_ID, PAYMENT_ID);

        expect(auditMock.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PAYMENT_REFUNDED',
            amount: null,
            metadata: { moneyWasHeld: false },
          }),
        );
      });
    });

    it('a transacção cancela a reserva e regista o valor relido dentro dela', async () => {
      setupHappyPath(
        heldPayment(),
        freshRefundable({ totalCharged: new Prisma.Decimal(3100) }),
      );

      await service.refund(ADMIN_ID, PAYMENT_ID);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.REFUNDED,
            refundAmount: 3100,
          }),
        }),
      );
    });

    it('a re-leitura dentro da transacção detecta corrida: pagamento já RELEASED', async () => {
      setupHappyPath(
        heldPayment(),
        freshRefundable({ status: PaymentStatus.RELEASED }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('CLIENT não pode reembolsar — ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.refund(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('OWNER não pode reembolsar — ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.refund(OWNER_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('utilizador inexistente recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.refund(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança NotFoundException se o pagamento não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança BadRequestException se o pagamento já está RELEASED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.RELEASED,
          booking: { id: BOOKING_ID, status: BookingStatus.COMPLETED },
          disputes: [],
        }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se o pagamento já está REFUNDED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.REFUNDED,
          booking: { id: BOOKING_ID, status: BookingStatus.CANCELLED },
          disputes: [],
        }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se há disputa não resolvida a favor do cliente', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
          booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
          disputes: [{ id: DISPUTE_ID, status: DisputeStatus.OPEN }],
        }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recusa se uma disputa foi aberta entre a leitura e a transacção, sem mexer em nada', async () => {
      setupHappyPath(
        heldPayment(),
        freshRefundable({ disputes: [{ id: 'disputa-nova' }] }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        'Este pagamento tem uma disputa aberta. O reembolso decide-se na resolução da disputa.',
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
      expect(ledgerMock.record).not.toHaveBeenCalled();
    });

    it('permite reembolso quando as disputas da reserva já estão fechadas', async () => {
      setupHappyPath(
        makePayment({
          status: PaymentStatus.HELD,
          booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
          // A consulta só traz disputas abertas: uma já resolvida não conta.
          disputes: [],
        }),
      );

      const result = await service.refund(ADMIN_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento reembolsado com sucesso.');
    });
  });

  // initiateMock()

  describe('initiateMock()', () => {
    it('lança ForbiddenException quando NODE_ENV é production', async () => {
      const previousEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await expect(
          service.initiateMock(CLIENT_ID, BOOKING_ID),
        ).rejects.toThrow(ForbiddenException);

        expect(prisma.booking.findUnique).not.toHaveBeenCalled();
        expect(prisma.payment.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = previousEnv;
      }
    });

    it('fluxo normal: inicia o pagamento e dá-o como recebido pelo caminho das cobranças', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.payment.findUnique.mockResolvedValueOnce(null); // receiptNumber único
      prisma.payment.create.mockResolvedValue(makePayment());
      prisma.payment.findUniqueOrThrow.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
          depositStatus: DepositStatus.HELD,
          heldAt: new Date(),
        }),
      );
      collectionsMock.confirmSimulated.mockResolvedValue({
        held: true,
        excess: 0,
      });

      const result = await service.initiateMock(CLIENT_ID, BOOKING_ID);

      expect(result.message).toBe(
        'Pagamento M-Pesa simulado com sucesso. Valor retido no cofre.',
      );
      expect(result.data.status).toBe(PaymentStatus.HELD);
      expect(collectionsMock.confirmSimulated).toHaveBeenCalledWith(
        CLIENT_ID,
        PAYMENT_ID,
      );
      expect(notifierMock.held).toHaveBeenCalledWith(PAYMENT_ID);
    });
  });

  // autoReleaseDue()

  describe('autoReleaseDue()', () => {
    const duePayment = (id: string) => ({
      id,
      bookingId: `booking-of-${id}`,
      serviceBookingId: null,
    });

    /** O que cada pagamento devido mostra ao ser relido dentro da transacção. */
    const freshHeld = (overrides: Record<string, unknown> = {}) => ({
      status: PaymentStatus.HELD,
      totalCharged: new Prisma.Decimal(2700),
      depositAmount: new Prisma.Decimal(500),
      ownerPayout: new Prisma.Decimal(1800),
      ownerId: OWNER_ID,
      disputes: [],
      ...overrides,
    });

    const setupDue = (ids: string[]) => {
      prisma.payment.findMany
        .mockResolvedValueOnce(ids.map(duePayment))
        .mockResolvedValue([]);
      prisma.payment.findUnique.mockResolvedValue(freshHeld());
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(
        makePayment({
          status: PaymentStatus.RELEASED,
          ownerPayout: new Prisma.Decimal(1800),
        }),
      );
      runTransaction();
    };

    it('procura pagamentos retidos, sem disputa, com o prazo vencido a contar do início e da entrada do dinheiro', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      const released = await service.autoReleaseDue();

      expect(released).toBe(0);
      const { where, orderBy } = prisma.payment.findMany.mock.calls[0][0];
      expect(where.status).toBe(PaymentStatus.HELD);
      const [rental] = where.OR;
      // Nem disputa aberta, nem uma retirada dentro do prazo.
      expect(rental.disputes.none.OR).toEqual([
        {
          status: {
            in: [
              DisputeStatus.OPEN,
              DisputeStatus.AWAITING_OWNER,
              DisputeStatus.UNDER_REVIEW,
            ],
          },
        },
        {
          status: DisputeStatus.WITHDRAWN,
          closedAt: { gt: rental.heldAt.lte },
        },
      ]);
      expect(rental.booking.status).toBe(BookingStatus.CONFIRMED);
      expect(rental.heldAt.lte.getTime()).toBeLessThan(Date.now());
      expect(rental.booking.startDate.lte).toEqual(rental.heldAt.lte);
      expect(orderBy).toEqual({ heldAt: 'asc' });
    });

    it('deixa de fora o dinheiro que iria para uma conta suspensa', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await service.autoReleaseDue();

      const { where } = prisma.payment.findMany.mock.calls[0][0];
      expect(where.owner).toEqual({ isActive: true });
    });

    it('procura também serviços que o provider concluiu há mais de 3 dias', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await service.autoReleaseDue();

      const { where } = prisma.payment.findMany.mock.calls[0][0];
      const [, concluded] = where.OR;
      expect(concluded.serviceBooking.status).toBe(
        ServiceBookingStatus.COMPLETED,
      );
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const deadline = concluded.serviceBooking.completedAt.lte.getTime();
      expect(Date.now() - deadline).toBeGreaterThanOrEqual(
        threeDaysMs - 60_000,
      );
      expect(Date.now() - deadline).toBeLessThan(
        threeDaysMs + 2 * 60 * 60 * 1000,
      );
    });

    it('libera o pagamento de um serviço concluído sem mexer na data de conclusão', async () => {
      const completedAt = new Date('2030-06-01T10:00:00.000Z');
      prisma.payment.findMany
        .mockResolvedValueOnce([
          {
            id: 'payment-uuid-s',
            bookingId: null,
            serviceBookingId: SERVICE_BOOKING_ID,
          },
        ])
        .mockResolvedValue([]);
      prisma.payment.findUnique.mockResolvedValue(
        freshHeld({ depositAmount: new Prisma.Decimal(0) }),
      );
      prisma.serviceBooking.findUnique.mockResolvedValue({
        status: ServiceBookingStatus.COMPLETED,
        completedAt,
      });
      prisma.payment.update.mockResolvedValue(
        makePayment({
          status: PaymentStatus.RELEASED,
          ownerPayout: new Prisma.Decimal(1800),
        }),
      );
      runTransaction();

      const released = await service.autoReleaseDue();

      expect(released).toBe(1);
      expect(prisma.serviceBooking.update).toHaveBeenCalledWith({
        where: { id: SERVICE_BOOKING_ID },
        data: { status: ServiceBookingStatus.COMPLETED, completedAt },
      });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AUTO_RELEASED,
          actorId: 'system',
          targetId: 'payment-uuid-s',
          metadata: { reason: 'service_confirmation_window_expired' },
        }),
      );
    });

    it('libera cada pagamento devido e põe a reserva ACTIVE', async () => {
      setupDue(['payment-uuid-a', 'payment-uuid-b']);

      const released = await service.autoReleaseDue();

      expect(released).toBe(2);
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'booking-of-payment-uuid-a' },
          data: expect.objectContaining({ status: BookingStatus.ACTIVE }),
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'payment-uuid-b' },
          data: expect.objectContaining({ status: PaymentStatus.RELEASED }),
        }),
      );
    });

    it('fica registado como acção do sistema, e não do cliente', async () => {
      setupDue(['payment-uuid-a']);

      await service.autoReleaseDue();

      expect(ledgerMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ paymentId: 'payment-uuid-a', actorId: null }),
      );
      expect(auditMock.record).toHaveBeenCalledTimes(1);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AUTO_RELEASED,
          actorId: 'system',
          targetId: 'payment-uuid-a',
        }),
      );
    });

    it('uma falha num item não trava os restantes nem fica em auditoria', async () => {
      setupDue(['payment-uuid-a', 'payment-uuid-b']);
      prisma.payment.findUnique
        .mockResolvedValueOnce(freshHeld({ disputes: [{ id: DISPUTE_ID }] }))
        .mockResolvedValueOnce(freshHeld());

      const released = await service.autoReleaseDue();

      expect(released).toBe(1);
      expect(auditMock.record).toHaveBeenCalledTimes(1);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_AUTO_RELEASED,
          targetId: 'payment-uuid-b',
        }),
      );
    });
  });
});
