import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BookingStatus,
  DisputeStatus,
  PaymentMethod,
  PaymentStatus,
  UserRole,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PaymentsService } from './payments.service';

const auditMock = { record: jest.fn() };

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const THIRD_ID = 'third-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const DISPUTE_ID = 'dispute-uuid-001';

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
  dispute: null,
  ...overrides,
});

const makePayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  bookingId: BOOKING_ID,
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
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  dispute: null,
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
  payment: {
    findUnique: jest.fn(),
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

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditMock },
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
          dispute: { id: DISPUTE_ID, status: DisputeStatus.OPEN },
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
    it('ADMIN marca pagamento PENDING como HELD com sucesso', async () => {
      const heldPayment = makePayment({
        status: PaymentStatus.HELD,
        heldAt: new Date(),
      });

      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.payment.update.mockResolvedValue(heldPayment);

      const result = await service.markHeld(ADMIN_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento marcado como retido com sucesso.');
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.HELD }),
        }),
      );
    });

    it('grava heldAt na actualização', async () => {
      const heldPayment = makePayment({
        status: PaymentStatus.HELD,
        heldAt: new Date(),
      });

      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(makePayment());
      prisma.payment.update.mockResolvedValue(heldPayment);

      await service.markHeld(ADMIN_ID, PAYMENT_ID);

      const updateCall = prisma.payment.update.mock.calls[0][0];
      expect(updateCall.data.heldAt).toBeInstanceOf(Date);
    });

    it('CLIENT não pode marcar como retido — recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.markHeld(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('OWNER não pode marcar como retido — recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.markHeld(OWNER_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('utilizador inexistente recebe ForbiddenException', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.markHeld(CLIENT_ID, PAYMENT_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lança NotFoundException se o pagamento não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.markHeld(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança BadRequestException se o pagamento já não está PENDING', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({ status: PaymentStatus.HELD }),
      );

      await expect(service.markHeld(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se a reserva está CANCELLED', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          booking: {
            id: BOOKING_ID,
            status: BookingStatus.CANCELLED,
          },
        }),
      );

      await expect(service.markHeld(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se há disputa associada', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          dispute: { id: DISPUTE_ID, status: DisputeStatus.OPEN },
        }),
      );

      await expect(service.markHeld(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // release()  ← O MAIS CRITICO - protege o escrow

  describe('release()', () => {
    const heldPayment = () =>
      makePayment({
        status: PaymentStatus.HELD,
        booking: {
          id: BOOKING_ID,
          status: BookingStatus.CONFIRMED,
          ownerId: OWNER_ID,
        },
      });

    const releasedPayment = makePayment({
      status: PaymentStatus.RELEASED,
      releasedAt: new Date(),
      depositReleasedAt: new Date(),
      booking: {
        id: BOOKING_ID,
        startDate: new Date(),
        endDate: new Date(),
        status: BookingStatus.COMPLETED,
      },
    });

    it('CLIENT libera o pagamento HELD com sucesso — usa $transaction', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      // booking.update e payment.update sao chamados para construir o array
      // que e passado ao $transaction (array-style Prisma transaction)
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(releasedPayment);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
      );

      const result = await service.release(CLIENT_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento liberado com sucesso.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('ADMIN pode liberar o pagamento HELD', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(releasedPayment);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
      );

      const result = await service.release(ADMIN_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento liberado com sucesso.');
    });

    it('a transacção actualiza booking para COMPLETED e payment para RELEASED', async () => {
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(releasedPayment);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
      );

      await service.release(CLIENT_ID, PAYMENT_ID);

      // Verifica que booking.update foi chamado com status COMPLETED
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.COMPLETED }),
        }),
      );
      // Verifica que payment.update foi chamado com status RELEASED
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.RELEASED }),
        }),
      );
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

    it('lança BadRequestException se a reserva não está CONFIRMED nem ACTIVE', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
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

    it('aceita liberação quando reserva está ACTIVE', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
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
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(releasedPayment);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
      );

      const result = await service.release(CLIENT_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento liberado com sucesso.');
    });

    it('lança BadRequestException se existe disputa associada ao pagamento', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
          booking: {
            id: BOOKING_ID,
            status: BookingStatus.CONFIRMED,
            ownerId: OWNER_ID,
          },
          dispute: { id: DISPUTE_ID, status: DisputeStatus.OPEN },
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
  });

  // refund()

  describe('refund()', () => {
    const heldPayment = () =>
      makePayment({
        status: PaymentStatus.HELD,
        booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
        dispute: null,
      });

    const refundedPayment = makePayment({
      status: PaymentStatus.REFUNDED,
      refundedAt: new Date(),
      booking: {
        id: BOOKING_ID,
        startDate: new Date(),
        endDate: new Date(),
        status: BookingStatus.CANCELLED,
      },
    });

    it('ADMIN reembolsa pagamento HELD com sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(heldPayment());
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(refundedPayment);
      prisma.$transaction.mockResolvedValue([{}, refundedPayment]);

      const result = await service.refund(ADMIN_ID, PAYMENT_ID);

      expect(result.message).toBe('Pagamento reembolsado com sucesso.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('ADMIN reembolsa pagamento PENDING com sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.PENDING,
          booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
          dispute: null,
        }),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(refundedPayment);
      prisma.$transaction.mockResolvedValue([{}, refundedPayment]);

      const result = await service.refund(ADMIN_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento reembolsado com sucesso.');
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
          dispute: null,
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
          dispute: null,
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
          dispute: { id: DISPUTE_ID, status: DisputeStatus.OPEN },
        }),
      );

      await expect(service.refund(ADMIN_ID, PAYMENT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('permite reembolso quando a disputa foi RESOLVED_CLIENT', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(
        makePayment({
          status: PaymentStatus.HELD,
          booking: { id: BOOKING_ID, status: BookingStatus.CONFIRMED },
          dispute: { id: DISPUTE_ID, status: DisputeStatus.RESOLVED_CLIENT },
        }),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(refundedPayment);
      prisma.$transaction.mockResolvedValue([{}, refundedPayment]);

      const result = await service.refund(ADMIN_ID, PAYMENT_ID);
      expect(result.message).toBe('Pagamento reembolsado com sucesso.');
    });

    it('a transacção cancela a reserva e regista refundAmount = totalCharged', async () => {
      const payment = heldPayment();
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.booking.update.mockResolvedValue({});
      prisma.payment.update.mockResolvedValue(refundedPayment);
      prisma.$transaction.mockResolvedValue([{}, refundedPayment]);

      await service.refund(ADMIN_ID, PAYMENT_ID);

      // Verifica que a reserva foi cancelada
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.REFUNDED,
            refundAmount: payment.totalCharged,
          }),
        }),
      );
    });
  });
});
