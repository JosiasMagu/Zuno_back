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
  DisputeReason,
  DisputeStatus,
  DisputeType,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { DisputesService } from './disputes.service';
import { AuditService } from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { DEPOSIT_CLAIM_WINDOW_HOURS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';

const auditMock = { record: jest.fn() };
const metricsMock = { businessEvents: { inc: jest.fn() } };
const ledgerMock = {
  record: jest.fn(),
  recordMany: jest.fn(),
  balance: jest.fn(),
};
const payoutsMock = { createPending: jest.fn() };

// CONSTANTES DE TESTE

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const SERVICE_BOOKING_ID = 'service-booking-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const DISPUTE_ID = 'dispute-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';

const HOUR_MS = 60 * 60 * 1000;

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

const makePayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  bookingId: BOOKING_ID,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  rentalAmount: new Prisma.Decimal(1500),
  depositAmount: new Prisma.Decimal(1000),
  platformFee: new Prisma.Decimal(150),
  totalCharged: new Prisma.Decimal(2650),
  ownerPayout: new Prisma.Decimal(1350),
  currency: 'MZN',
  method: 'MPESA',
  mpesaReference: null,
  status: PaymentStatus.HELD,
  depositStatus: DepositStatus.HELD,
  heldAt: new Date(),
  releasedAt: null,
  refundedAt: null,
  refundAmount: null,
  depositReleasedAt: null,
  receiptNumber: 'REC-001',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  equipmentId: EQUIPMENT_ID,
  ownerId: OWNER_ID,
  startDate: new Date(),
  endDate: new Date(),
  totalDays: 3,
  rentalAmount: new Prisma.Decimal(1500),
  depositAmount: new Prisma.Decimal(1000),
  platformFee: new Prisma.Decimal(150),
  totalAmount: new Prisma.Decimal(2650),
  status: BookingStatus.CONFIRMED,
  deliveryAddress: null,
  clientNote: null,
  confirmedAt: new Date(),
  cancelledAt: null,
  cancellationReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  payment: makePayment(),
  dispute: null,
  ...overrides,
});

const makeDispute = (overrides: Record<string, unknown> = {}) => ({
  id: DISPUTE_ID,
  bookingId: BOOKING_ID,
  serviceBookingId: null,
  paymentId: PAYMENT_ID,
  openedBy: CLIENT_ID,
  type: DisputeType.PAYMENT,
  reason: DisputeReason.NOT_DELIVERED,
  description: 'Equipamento não foi entregue.',
  ownerResponse: null,
  status: DisputeStatus.AWAITING_OWNER,
  resolution: null,
  refundPercent: null,
  autoResolvedAt: null,
  ownerDeadline: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  booking: {
    id: BOOKING_ID,
    equipmentId: EQUIPMENT_ID,
    status: BookingStatus.DISPUTED,
    startDate: new Date(),
    endDate: new Date(),
    clientId: CLIENT_ID,
    ownerId: OWNER_ID,
  },
  serviceBooking: null,
  payment: makePayment(),
  opener: {
    id: CLIENT_ID,
    name: 'Cliente',
    avatarUrl: null,
  },
  ...overrides,
});

// Payload da re-leitura dentro da transacção (reloadForResolution):
// select de status/type + payment financeiro.
const makeFreshPayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  status: PaymentStatus.HELD,
  depositStatus: DepositStatus.HELD,
  totalCharged: new Prisma.Decimal(2650),
  rentalAmount: new Prisma.Decimal(1500),
  platformFee: new Prisma.Decimal(150),
  depositAmount: new Prisma.Decimal(1000),
  ownerPayout: new Prisma.Decimal(1350),
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  ...overrides,
});

const makeFreshDispute = (overrides: Record<string, unknown> = {}) => ({
  status: DisputeStatus.UNDER_REVIEW,
  type: DisputeType.PAYMENT,
  payment: makeFreshPayment(),
  ...overrides,
});

// MOCK DO PRISMA

const makePrismaMock = () => ({
  user: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn(), update: jest.fn() },
  serviceBooking: { findUnique: jest.fn(), update: jest.fn() },
  equipment: { findUnique: jest.fn(), update: jest.fn() },
  payment: { update: jest.fn() },
  dispute: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
});

// SUITE PRINCIPAL

describe('DisputesService', () => {
  let service: DisputesService;
  let prisma: ReturnType<typeof makePrismaMock>;

  const passthroughTx = () => {
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
  };

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditMock },
        { provide: MetricsService, useValue: metricsMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: PayoutsService, useValue: payoutsMock },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
  });

  afterEach(() => jest.clearAllMocks());

  // create()

  describe('create()', () => {
    const validDto = {
      bookingId: BOOKING_ID,
      paymentId: PAYMENT_ID,
      reason: DisputeReason.NOT_DELIVERED,
      description: 'Equipamento não foi entregue.',
    };

    const setupHappyTx = (disputeResult = makeDispute()) => {
      passthroughTx();
      prisma.booking.update.mockResolvedValue({});
      prisma.dispute.create.mockResolvedValue(disputeResult);
    };

    it('lança BadRequestException se fornecer bookingId E serviceBookingId', async () => {
      await expect(
        service.create(CLIENT_ID, {
          ...validDto,
          serviceBookingId: SERVICE_BOOKING_ID,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Forneça exactamente um de bookingId ou serviceBookingId.',
        ),
      );
    });

    it('lança BadRequestException se não fornecer nem bookingId nem serviceBookingId', async () => {
      await expect(
        service.create(CLIENT_ID, {
          paymentId: PAYMENT_ID,
          reason: DisputeReason.NOT_DELIVERED,
          description: 'Equipamento não foi entregue.',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Forneça exactamente um de bookingId ou serviceBookingId.',
        ),
      );
    });

    it('cria a disputa com sucesso — CLIENT abre disputa', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      const result = await service.create(CLIENT_ID, validDto);

      expect(result.message).toBe('Disputa criada com sucesso.');
      expect(result.data.id).toBe(DISPUTE_ID);
    });

    it('cria a disputa com sucesso — OWNER abre disputa', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      const result = await service.create(OWNER_ID, validDto);
      expect(result.message).toBe('Disputa criada com sucesso.');
    });

    it('regista métrica e auditoria DISPUTE_OPENED no sucesso', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      await service.create(CLIENT_ID, validDto);

      expect(metricsMock.businessEvents.inc).toHaveBeenCalledWith({
        event: 'dispute_opened',
      });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_OPENED,
          actorId: CLIENT_ID,
          targetId: DISPUTE_ID,
        }),
      );
    });

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança BadRequestException se reserva não tem pagamento', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ payment: null }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'Esta reserva ainda não possui pagamento associado.',
        ),
      );
    });

    it('lança BadRequestException se paymentId não corresponde ao da reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ payment: makePayment({ id: 'outro-payment-id' }) }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'O pagamento informado não corresponde à reserva.',
        ),
      );
    });

    it('lança ForbiddenException se utilizador não é parte da reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      await expect(service.create(STRANGER_ID, validDto)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para abrir disputa nesta reserva.',
        ),
      );
    });

    it('lança BadRequestException se já existe disputa na reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ dispute: { id: 'existing-dispute' } }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'Já existe uma disputa associada a esta reserva.',
        ),
      );
    });

    it('lança BadRequestException se pagamento está PENDING — não pode abrir disputa', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          payment: makePayment({ status: PaymentStatus.PENDING }),
        }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'O estado atual do pagamento não permite abrir disputa.',
        ),
      );
    });

    it('lança BadRequestException se pagamento está REFUNDED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          payment: makePayment({ status: PaymentStatus.REFUNDED }),
        }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita disputa em pagamento RELEASED — escrow já libertado', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({
          payment: makePayment({ status: PaymentStatus.RELEASED }),
        }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException(
          'O estado atual do pagamento não permite abrir disputa.',
        ),
      );
    });

    it('marca a booking como DISPUTED dentro da transacção', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      await service.create(CLIENT_ID, validDto);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.DISPUTED }),
        }),
      );
    });

    it('cria disputa com status AWAITING_OWNER', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      await service.create(CLIENT_ID, validDto);

      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.AWAITING_OWNER,
          }),
        }),
      );
    });

    it('trim na descrição', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      setupHappyTx();

      await service.create(CLIENT_ID, {
        ...validDto,
        description: '  com espaços  ',
      });

      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ description: 'com espaços' }),
        }),
      );
    });
  });

  // claimDeposit() — D1: provider reclama o depósito no checkpoint 2

  describe('claimDeposit()', () => {
    const dto = {
      bookingId: BOOKING_ID,
      description: 'A betoneira foi devolvida com o motor queimado.',
    };

    const makeClaimableBooking = (overrides: Record<string, unknown> = {}) =>
      makeBooking({
        status: BookingStatus.ACTIVE,
        endDate: new Date(Date.now() - HOUR_MS),
        payment: makePayment({
          status: PaymentStatus.RELEASED,
          depositStatus: DepositStatus.HELD,
        }),
        dispute: null,
        ...overrides,
      });

    const setupHappyTx = (
      disputeResult = makeDispute({
        type: DisputeType.DEPOSIT,
        status: DisputeStatus.UNDER_REVIEW,
        openedBy: OWNER_ID,
        reason: DisputeReason.DAMAGED,
      }),
    ) => {
      passthroughTx();
      prisma.booking.update.mockResolvedValue({});
      prisma.dispute.create.mockResolvedValue(disputeResult);
    };

    it('lança NotFoundException se reserva não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança ForbiddenException se não é o owner do booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());

      await expect(service.claimDeposit(CLIENT_ID, dto)).rejects.toThrow(
        new ForbiddenException(
          'Só o proprietário do equipamento pode reclamar o depósito.',
        ),
      );
    });

    it('lança BadRequestException se a reserva não está ACTIVE', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({ status: BookingStatus.CONFIRMED }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'O depósito só pode ser reclamado enquanto a reserva está ativa (antes de confirmar a devolução).',
        ),
      );
    });

    it('lança BadRequestException se já existe disputa na reserva', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({ dispute: { id: 'existing-dispute' } }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'Já existe uma disputa associada a esta reserva.',
        ),
      );
    });

    it('lança BadRequestException se o pagamento não está RELEASED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({
          payment: makePayment({
            status: PaymentStatus.HELD,
            depositStatus: DepositStatus.HELD,
          }),
        }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'O estado atual do pagamento não permite reclamar o depósito.',
        ),
      );
    });

    it('lança BadRequestException se o depósito já não está HELD', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({
          payment: makePayment({
            status: PaymentStatus.RELEASED,
            depositStatus: DepositStatus.RETURNED,
          }),
        }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'Esta reserva não tem depósito retido para reclamar.',
        ),
      );
    });

    it('lança BadRequestException se depositAmount é zero', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({
          payment: makePayment({
            status: PaymentStatus.RELEASED,
            depositStatus: DepositStatus.HELD,
            depositAmount: new Prisma.Decimal(0),
          }),
        }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'Esta reserva não tem depósito retido para reclamar.',
        ),
      );
    });

    it('lança BadRequestException se a janela de reclamação já expirou', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({
          endDate: new Date(
            Date.now() - (DEPOSIT_CLAIM_WINDOW_HOURS + 1) * HOUR_MS,
          ),
        }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'A janela de reclamação do depósito já expirou.',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sucesso — booking → DISPUTED e disputa DEPOSIT em UNDER_REVIEW', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());
      setupHappyTx();

      const result = await service.claimDeposit(OWNER_ID, dto);

      expect(result.message).toBe(
        'Reclamação do depósito registada. Um administrador vai analisar.',
      );
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: { status: BookingStatus.DISPUTED },
        }),
      );
      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: DisputeType.DEPOSIT,
            status: DisputeStatus.UNDER_REVIEW,
            openedBy: OWNER_ID,
          }),
        }),
      );
    });

    it('usa DAMAGED como reason por omissão', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());
      setupHappyTx();

      await service.claimDeposit(OWNER_ID, dto);

      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: DisputeReason.DAMAGED }),
        }),
      );
    });

    it('regista métrica e auditoria DEPOSIT_CLAIM_OPENED com o valor do depósito', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());
      setupHappyTx();

      await service.claimDeposit(OWNER_ID, dto);

      expect(metricsMock.businessEvents.inc).toHaveBeenCalledWith({
        event: 'dispute_opened',
      });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DEPOSIT_CLAIM_OPENED,
          actorId: OWNER_ID,
          targetId: DISPUTE_ID,
          amount: new Prisma.Decimal(1000),
        }),
      );
    });
  });

  // findMyDisputes()

  describe('findMyDisputes()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findMyDisputes(CLIENT_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('CLIENT vê apenas as suas disputas (OR com openedBy, clientId, ownerId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.dispute.findMany.mockResolvedValue([makeDispute()]);
      prisma.dispute.count.mockResolvedValue(1);

      await service.findMyDisputes(CLIENT_ID, { page: 1, limit: 10 });

      const where = (
        prisma.dispute.findMany.mock.calls[0][0] as { where: unknown }
      ).where as Record<string, unknown>;
      expect(where).toHaveProperty('OR');
    });

    it('ADMIN vê todas as disputas (sem filtro OR)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findMany.mockResolvedValue([]);
      prisma.dispute.count.mockResolvedValue(0);

      await service.findMyDisputes(ADMIN_ID, { page: 1, limit: 10 });

      const where = (
        prisma.dispute.findMany.mock.calls[0][0] as { where: unknown }
      ).where as Record<string, unknown>;
      expect(where).not.toHaveProperty('OR');
    });

    it('filtra por status quando fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.dispute.findMany.mockResolvedValue([]);
      prisma.dispute.count.mockResolvedValue(0);

      await service.findMyDisputes(CLIENT_ID, {
        page: 1,
        limit: 10,
        status: DisputeStatus.UNDER_REVIEW,
      });

      const where = (
        prisma.dispute.findMany.mock.calls[0][0] as { where: unknown }
      ).where as Record<string, unknown>;
      expect(where).toMatchObject({ status: DisputeStatus.UNDER_REVIEW });
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.dispute.findMany.mockResolvedValue([makeDispute()]);
      prisma.dispute.count.mockResolvedValue(15);

      const result = await service.findMyDisputes(CLIENT_ID, {
        page: 2,
        limit: 5,
      });

      expect(result.meta).toMatchObject({
        page: 2,
        limit: 5,
        total: 15,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });
  });

  // findOne()

  describe('findOne()', () => {
    it('lança NotFoundException se disputa não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(makeDispute());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT (opener) pode ver a disputa', async () => {
      prisma.dispute.findUnique.mockResolvedValue(makeDispute());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      const result = await service.findOne(CLIENT_ID, DISPUTE_ID);
      expect(result.data.id).toBe(DISPUTE_ID);
    });

    it('OWNER da booking pode ver a disputa', async () => {
      prisma.dispute.findUnique.mockResolvedValue(makeDispute());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      const result = await service.findOne(OWNER_ID, DISPUTE_ID);
      expect(result.data.id).toBe(DISPUTE_ID);
    });

    it('ADMIN pode ver qualquer disputa', async () => {
      prisma.dispute.findUnique.mockResolvedValue(makeDispute());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );

      const result = await service.findOne(ADMIN_ID, DISPUTE_ID);
      expect(result.data.id).toBe(DISPUTE_ID);
    });

    it('presenter expõe o type da disputa', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ type: DisputeType.DEPOSIT }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );

      const result = await service.findOne(ADMIN_ID, DISPUTE_ID);
      expect(result.data.type).toBe(DisputeType.DEPOSIT);
    });

    it('terceiro sem relação recebe ForbiddenException', async () => {
      prisma.dispute.findUnique.mockResolvedValue(makeDispute());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(service.findOne(STRANGER_ID, DISPUTE_ID)).rejects.toThrow(
        new ForbiddenException('Não tens permissão para ver esta disputa.'),
      );
    });
  });

  // respond()

  describe('respond()', () => {
    const dto = {
      ownerResponse: 'O equipamento foi entregue conforme acordado.',
    };

    const disputeWithOwner = makeDispute();

    it('lança NotFoundException se disputa não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(disputeWithOwner);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new NotFoundException('Utilizador não encontrado.'),
      );
    });

    it('CLIENT não pode responder — só OWNER ou ADMIN', async () => {
      prisma.dispute.findUnique.mockResolvedValue(disputeWithOwner);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(service.respond(CLIENT_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para responder a esta disputa.',
        ),
      );
    });

    it('lança BadRequestException se disputa já está UNDER_REVIEW', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.UNDER_REVIEW }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new BadRequestException(
          'Esta disputa não pode mais receber resposta do owner.',
        ),
      );
    });

    it('lança BadRequestException se disputa já está resolvida', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.RESOLVED_CLIENT }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('OWNER responde com sucesso — status muda para UNDER_REVIEW', async () => {
      prisma.dispute.findUnique.mockResolvedValue(disputeWithOwner);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.dispute.update.mockResolvedValue(
        makeDispute({
          status: DisputeStatus.UNDER_REVIEW,
          ownerResponse: dto.ownerResponse,
        }),
      );

      const result = await service.respond(OWNER_ID, DISPUTE_ID, dto);

      expect(result.message).toBe(
        'Resposta da disputa registrada com sucesso.',
      );
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.UNDER_REVIEW,
            ownerResponse: dto.ownerResponse,
          }),
        }),
      );
    });

    it('ADMIN também pode responder', async () => {
      prisma.dispute.findUnique.mockResolvedValue(disputeWithOwner);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.update.mockResolvedValue(
        makeDispute({ status: DisputeStatus.UNDER_REVIEW }),
      );

      const result = await service.respond(ADMIN_ID, DISPUTE_ID, dto);
      expect(result.message).toBe(
        'Resposta da disputa registrada com sucesso.',
      );
    });

    it('faz trim na ownerResponse', async () => {
      prisma.dispute.findUnique.mockResolvedValue(disputeWithOwner);
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.dispute.update.mockResolvedValue(
        makeDispute({ status: DisputeStatus.UNDER_REVIEW }),
      );

      await service.respond(OWNER_ID, DISPUTE_ID, {
        ownerResponse: '  resposta com espaços  ',
      });

      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ownerResponse: 'resposta com espaços',
          }),
        }),
      );
    });
  });

  // HELPERS DAS RESOLUÇÕES
  //
  // O dispute.findUnique é chamado 2x: fora da transacção (include completo)
  // e dentro (reloadForResolution, com select) — daí os mockResolvedValueOnce.

  type ResolutionSetup = {
    outer?: ReturnType<typeof makeDispute>;
    fresh?: ReturnType<typeof makeFreshDispute>;
    resolved?: ReturnType<typeof makeDispute>;
  };

  const setupAdmin = () => {
    prisma.user.findUnique.mockResolvedValue(
      makeUser(ADMIN_ID, UserRole.ADMIN),
    );
  };

  const setupResolution = ({
    outer = makeDispute(),
    fresh = makeFreshDispute(),
    resolved = makeDispute({ status: DisputeStatus.RESOLVED_CLIENT }),
  }: ResolutionSetup = {}) => {
    setupAdmin();
    prisma.dispute.findUnique
      .mockResolvedValueOnce(outer)
      .mockResolvedValueOnce(fresh);
    passthroughTx();
    prisma.booking.update.mockResolvedValue({});
    prisma.serviceBooking.update.mockResolvedValue({});
    prisma.payment.update.mockResolvedValue({});
    prisma.equipment.findUnique.mockResolvedValue({
      availableQuantity: 0,
      quantity: 2,
    });
    prisma.equipment.update.mockResolvedValue({});
    prisma.dispute.update.mockResolvedValue(resolved);
  };

  const makeDepositDispute = (overrides: Record<string, unknown> = {}) =>
    makeDispute({
      type: DisputeType.DEPOSIT,
      status: DisputeStatus.UNDER_REVIEW,
      openedBy: OWNER_ID,
      payment: makePayment({
        status: PaymentStatus.RELEASED,
        depositStatus: DepositStatus.HELD,
      }),
      ...overrides,
    });

  const makeDepositFresh = (paymentOverrides: Record<string, unknown> = {}) =>
    makeFreshDispute({
      type: DisputeType.DEPOSIT,
      payment: makeFreshPayment({
        status: PaymentStatus.RELEASED,
        depositStatus: DepositStatus.HELD,
        ...paymentOverrides,
      }),
    });

  // resolveClient() — dinheiro volta ao cliente

  describe('resolveClient()', () => {
    it('lança ForbiddenException se não é ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(
        service.resolveClient(CLIENT_ID, DISPUTE_ID),
      ).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para executar esta operação.',
        ),
      );
    });

    it('lança NotFoundException se disputa não existe', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.RESOLVED_CLIENT }),
      );

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento está PENDING', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.PENDING }),
        }),
      );

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
    });

    it('REJEITA pagamento RELEASED em disputa PAYMENT — guarda contra desembolso duplo', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.RELEASED }),
        }),
      );

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('revalida dentro da transacção — falha se entretanto já foi resolvida', async () => {
      setupResolution({
        fresh: makeFreshDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
      expect(prisma.dispute.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.dispute.update).not.toHaveBeenCalled();
    });

    it('PAYMENT — cancela a booking, restaura o equipamento e reembolsa o total', async () => {
      setupResolution();

      const result = await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do cliente.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
      );
      expect(prisma.equipment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: EQUIPMENT_ID } }),
      );
      expect(prisma.equipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EQUIPMENT_ID },
          data: { availableQuantity: 1, isAvailable: true },
        }),
      );
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 2650,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.CLIENT_REFUND,
          amount: 2650,
        }),
      );
    });

    it('PAYMENT — pagamento fica REFUNDED com ownerPayout 0 e depósito RETURNED', async () => {
      setupResolution();

      await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PAYMENT_ID },
          data: expect.objectContaining({
            status: PaymentStatus.REFUNDED,
            refundAmount: 2650,
            ownerPayout: 0,
            depositStatus: DepositStatus.RETURNED,
          }),
        }),
      );
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.RESOLVED_CLIENT,
          }),
        }),
      );
    });

    it('PAYMENT — auditoria DISPUTE_RESOLVED_CLIENT com metadata.type', async () => {
      setupResolution();

      await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESOLVED_CLIENT,
          actorId: ADMIN_ID,
          targetId: DISPUTE_ID,
          metadata: { type: DisputeType.PAYMENT },
        }),
      );
    });

    it('PAYMENT em serviceBooking — cancela o serviceBooking sem tocar em equipamento', async () => {
      const serviceBooking = {
        id: SERVICE_BOOKING_ID,
        status: ServiceBookingStatus.DISPUTED,
        scheduledFor: null,
        clientId: CLIENT_ID,
        providerId: OWNER_ID,
      };
      setupResolution({
        outer: makeDispute({
          bookingId: null,
          booking: null,
          serviceBookingId: SERVICE_BOOKING_ID,
          serviceBooking,
        }),
        resolved: makeDispute({
          status: DisputeStatus.RESOLVED_CLIENT,
          bookingId: null,
          booking: null,
          serviceBookingId: SERVICE_BOOKING_ID,
          serviceBooking,
        }),
      });

      await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SERVICE_BOOKING_ID },
          data: expect.objectContaining({
            status: ServiceBookingStatus.CANCELLED,
          }),
        }),
      );
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });

    it('DEPOSIT — exige pagamento RELEASED com depósito HELD', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDepositDispute({
          payment: makePayment({
            status: PaymentStatus.HELD,
            depositStatus: DepositStatus.HELD,
          }),
        }),
      );

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O depósito desta disputa não está num estado válido para resolução.',
        ),
      );
    });

    it('DEPOSIT — devolve o depósito ao cliente e completa a booking', async () => {
      setupResolution({
        outer: makeDepositDispute(),
        fresh: makeDepositFresh(),
        resolved: makeDepositDispute({
          status: DisputeStatus.RESOLVED_CLIENT,
        }),
      });

      const result = await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do cliente.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.COMPLETED }),
        }),
      );
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.CLIENT,
          amount: 1000,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.DEPOSIT_RETURN,
          amount: 1000,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.RETURNED,
          }),
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESOLVED_CLIENT,
          amount: new Prisma.Decimal(1000),
          metadata: { type: DisputeType.DEPOSIT },
        }),
      );
    });
  });

  // resolveOwner() — dinheiro vai para o owner

  describe('resolveOwner()', () => {
    it('lança ForbiddenException se não é ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(service.resolveOwner(OWNER_ID, DISPUTE_ID)).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para executar esta operação.',
        ),
      );
    });

    it('lança NotFoundException se disputa não existe', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida (RESOLVED_OWNER)', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      );

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida (RESOLVED_PARTIAL)', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.RESOLVED_PARTIAL }),
      );

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento está PENDING', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.PENDING }),
        }),
      );

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
    });

    it('REJEITA pagamento RELEASED em disputa PAYMENT — o provider já recebeu', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.RELEASED }),
        }),
      );

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('PAYMENT com depósito — payout ao provider, fee à plataforma e depósito ao cliente', async () => {
      setupResolution({
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      const result = await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do owner.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.COMPLETED }),
        }),
      );
      expect(prisma.equipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { availableQuantity: 1, isAvailable: true },
        }),
      );
      // ownerPayout 1350 + platform (2650 − 1000 − 1350 = 300) + depósito 1000
      expect(ledgerMock.record).toHaveBeenCalledTimes(3);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          party: LedgerParty.PROVIDER,
          amount: 1350,
        }),
      );
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          party: LedgerParty.PLATFORM,
          amount: 300,
        }),
      );
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          party: LedgerParty.CLIENT,
          amount: 1000,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: OWNER_ID,
          kind: PayoutKind.PROVIDER_PAYOUT,
          amount: 1350,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.DEPOSIT_RETURN,
          amount: 1000,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.RELEASED,
            depositStatus: DepositStatus.RETURNED,
          }),
        }),
      );
    });

    it('PAYMENT sem depósito — não devolve depósito e depositStatus fica NONE', async () => {
      setupResolution({
        fresh: makeFreshDispute({
          payment: makeFreshPayment({
            depositAmount: new Prisma.Decimal(0),
            depositStatus: DepositStatus.NONE,
            totalCharged: new Prisma.Decimal(1650),
          }),
        }),
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      // provider 1350 + platform (1650 − 0 − 1350 = 300); sem OUT CLIENT
      expect(ledgerMock.record).toHaveBeenCalledTimes(2);
      expect(payoutsMock.createPending).toHaveBeenCalledTimes(1);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: PayoutKind.PROVIDER_PAYOUT }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.NONE,
          }),
        }),
      );
    });

    it('PAYMENT — auditoria DISPUTE_RESOLVED_OWNER com metadata.type', async () => {
      setupResolution({
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESOLVED_OWNER,
          metadata: { type: DisputeType.PAYMENT },
        }),
      );
    });

    it('DEPOSIT — provider fica com o depósito (CLAIMED) e audit DEPOSIT_CLAIMED', async () => {
      setupResolution({
        outer: makeDepositDispute(),
        fresh: makeDepositFresh(),
        resolved: makeDepositDispute({
          status: DisputeStatus.RESOLVED_OWNER,
        }),
      });

      const result = await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do owner.');
      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PROVIDER,
          amount: 1000,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: OWNER_ID,
          kind: PayoutKind.DEPOSIT_CLAIM,
          amount: 1000,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.CLAIMED,
          }),
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DEPOSIT_CLAIMED,
          amount: new Prisma.Decimal(1000),
          metadata: { type: DisputeType.DEPOSIT },
        }),
      );
    });
  });

  // resolvePartial() — reembolso parcial (política D2: pct sobre o rental)

  describe('resolvePartial()', () => {
    const dto = { refundPercent: 50 };

    it('lança ForbiddenException se não é ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );

      await expect(
        service.resolvePartial(CLIENT_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new ForbiddenException(
          'Não tens permissão para executar esta operação.',
        ),
      );
    });

    it('lança NotFoundException se disputa não existe', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(new NotFoundException('Disputa não encontrada.'));
    });

    it('lança BadRequestException se disputa já foi resolvida', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.RESOLVED_PARTIAL }),
      );

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento está FAILED', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.FAILED }),
        }),
      );

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
    });

    it('REJEITA pagamento RELEASED em disputa PAYMENT', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({
          payment: makePayment({ status: PaymentStatus.RELEASED }),
        }),
      );

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('PAYMENT — pct aplica-se ao RENTAL: rental 1000, fee 100, 50% → refund 500 e payout 400', async () => {
      setupResolution({
        fresh: makeFreshDispute({
          payment: makeFreshPayment({
            rentalAmount: new Prisma.Decimal(1000),
            platformFee: new Prisma.Decimal(100),
            depositAmount: new Prisma.Decimal(0),
            depositStatus: DepositStatus.NONE,
            totalCharged: new Prisma.Decimal(1100),
            ownerPayout: new Prisma.Decimal(900),
          }),
        }),
        resolved: makeDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 50,
        }),
      });

      await service.resolvePartial(ADMIN_ID, DISPUTE_ID, { refundPercent: 50 });

      // refund = 50% × 1000 = 500; payout = 1000 − 500 − 100 = 400;
      // retido pela plataforma = 1100 − 0 − 500 − 400 = 200.
      expect(ledgerMock.recordMany).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({ party: LedgerParty.CLIENT, amount: 500 }),
        expect.objectContaining({ party: LedgerParty.PROVIDER, amount: 400 }),
        expect.objectContaining({ party: LedgerParty.PLATFORM, amount: 200 }),
      ]);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.CLIENT_REFUND,
          amount: 500,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: OWNER_ID,
          kind: PayoutKind.PROVIDER_PAYOUT,
          amount: 400,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.PARTIALLY_REFUNDED,
            refundAmount: 500,
            ownerPayout: 400,
            depositStatus: DepositStatus.NONE,
          }),
        }),
      );
    });

    it('PAYMENT com depósito — depósito volta ao cliente à parte do refund', async () => {
      setupResolution({
        resolved: makeDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 50,
        }),
      });

      const result = await service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto);

      expect(result.message).toBe(
        'Disputa resolvida parcialmente com sucesso.',
      );
      // rental 1500 → refund 750; payout = 1500 − 750 − 150 = 600;
      // retido = 2650 − 1000 − 750 − 600 = 300; depósito 1000 à parte.
      expect(ledgerMock.recordMany).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({ party: LedgerParty.CLIENT, amount: 750 }),
        expect.objectContaining({ party: LedgerParty.PROVIDER, amount: 600 }),
        expect.objectContaining({ party: LedgerParty.PLATFORM, amount: 300 }),
        expect.objectContaining({ party: LedgerParty.CLIENT, amount: 1000 }),
      ]);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.DEPOSIT_RETURN,
          amount: 1000,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.PARTIALLY_REFUNDED,
            refundAmount: 750,
            ownerPayout: 600,
            depositStatus: DepositStatus.RETURNED,
          }),
        }),
      );
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.RESOLVED_PARTIAL,
            refundPercent: 50,
          }),
        }),
      );
    });

    it('PAYMENT — auditoria com amount = refund e metadata {refundPercent, type}', async () => {
      setupResolution({
        resolved: makeDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 50,
        }),
      });

      await service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto);

      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESOLVED_PARTIAL,
          amount: 750,
          metadata: { refundPercent: 50, type: DisputeType.PAYMENT },
        }),
      );
    });

    it('DEPOSIT — divide o depósito: 40% cliente / 60% provider e fica SPLIT', async () => {
      setupResolution({
        outer: makeDepositDispute(),
        fresh: makeDepositFresh(),
        resolved: makeDepositDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 40,
        }),
      });

      await service.resolvePartial(ADMIN_ID, DISPUTE_ID, { refundPercent: 40 });

      expect(ledgerMock.recordMany).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({ party: LedgerParty.CLIENT, amount: 400 }),
        expect.objectContaining({ party: LedgerParty.PROVIDER, amount: 600 }),
      ]);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: CLIENT_ID,
          kind: PayoutKind.DEPOSIT_RETURN,
          amount: 400,
        }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: OWNER_ID,
          kind: PayoutKind.DEPOSIT_CLAIM,
          amount: 600,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.SPLIT,
          }),
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESOLVED_PARTIAL,
          amount: 400,
          metadata: { refundPercent: 40, type: DisputeType.DEPOSIT },
        }),
      );
    });

    it('revalida dentro da transacção — falha se entretanto já foi resolvida', async () => {
      setupResolution({
        fresh: makeFreshDispute({ status: DisputeStatus.RESOLVED_CLIENT }),
      });

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
      expect(ledgerMock.recordMany).not.toHaveBeenCalled();
      expect(prisma.dispute.update).not.toHaveBeenCalled();
    });
  });
});
