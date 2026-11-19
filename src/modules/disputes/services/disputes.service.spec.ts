import { ConfigService } from '@nestjs/config';
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

import { DisputeNotifier } from './dispute-notifier.service';
import { DisputesService } from './disputes.service';
import { AuditService } from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { DEPOSIT_CLAIM_WINDOW_HOURS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { ApiException } from '../../../common/exceptions/api.exception';
import { EscrowRefundService } from '../../payments/services/escrow-refund.service';
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
const notifierMock = {
  opened: jest.fn(),
  responded: jest.fn(),
  responseWindowClosed: jest.fn(),
  resolved: jest.fn(),
  withdrawn: jest.fn(),
};

// Nome da conta Cloudinary nos testes, e uma prova carregada por cada parte.
const CLOUD_NAME = 'zuno-test';
const configMock = { getOrThrow: jest.fn(() => CLOUD_NAME) };
const evidenceOf = (userId: string, name = 'foto-1') =>
  `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1/zuno/disputes/${userId}/${name}.jpg`;

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
  disputes: [],
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
  evidenceUrls: [],
  response: null,
  responseEvidenceUrls: [],
  respondedAt: null,
  respondedBy: null,
  // Por omissão, já em análise: é o estado em que um admin a resolve.
  status: DisputeStatus.UNDER_REVIEW,
  resolution: null,
  refundPercent: null,
  autoResolvedAt: null,
  responseDeadline: new Date(),
  closedAt: null,
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
  payment: { findUnique: jest.fn(), update: jest.fn() },
  dispute: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
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
        EscrowRefundService,
        { provide: LedgerService, useValue: ledgerMock },
        { provide: PayoutsService, useValue: payoutsMock },
        { provide: ConfigService, useValue: configMock },
        { provide: DisputeNotifier, useValue: notifierMock },
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
      // Re-leitura do pagamento dentro da transacção: continua retido e sem disputa.
      prisma.payment.findUnique.mockResolvedValue({
        status: PaymentStatus.HELD,
        disputes: [],
      });
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
        makeBooking({ disputes: [{ id: 'existing-dispute' }] }),
      );

      await expect(service.create(CLIENT_ID, validDto)).rejects.toThrow(
        new BadRequestException('Já existe uma disputa aberta nesta reserva.'),
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

    describe('quando a reserva muda enquanto a disputa é aberta', () => {
      const openError = async (): Promise<Error> => {
        try {
          await service.create(CLIENT_ID, validDto);
        } catch (error) {
          return error as Error;
        }
        throw new Error('A disputa devia ter sido recusada.');
      };

      beforeEach(() => {
        prisma.booking.findUnique.mockResolvedValue(makeBooking());
        setupHappyTx();
      });

      it('recusa se o cliente confirmou a entrega entretanto', async () => {
        prisma.payment.findUnique.mockResolvedValue({
          status: PaymentStatus.RELEASED,
          disputes: [],
        });

        const error = await openError();

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(
          'O estado atual do pagamento não permite abrir disputa.',
        );
        expect(prisma.booking.update).not.toHaveBeenCalled();
        expect(prisma.dispute.create).not.toHaveBeenCalled();
      });

      it('recusa se a outra parte abriu a sua disputa entretanto', async () => {
        prisma.payment.findUnique.mockResolvedValue({
          status: PaymentStatus.HELD,
          disputes: [{ id: 'outra-disputa' }],
        });

        const error = await openError();

        expect(error.message).toBe(
          'Já existe uma disputa aberta nesta reserva.',
        );
        expect(prisma.dispute.create).not.toHaveBeenCalled();
      });

      it('responde 400, e não 500, a quem perde a corrida na base', async () => {
        prisma.$transaction.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Write conflict', {
            code: 'P2034',
            clientVersion: 'teste',
          }),
        );

        const error = await openError();

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toContain('mudou de estado');
      });
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
        disputes: [],
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
        makeClaimableBooking({ disputes: [{ id: 'existing-dispute' }] }),
      );

      await expect(service.claimDeposit(OWNER_ID, dto)).rejects.toThrow(
        new BadRequestException('Já existe uma disputa aberta nesta reserva.'),
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

    it('sucesso — a reserva fica em disputa e o cliente tem prazo para responder', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());
      setupHappyTx();

      const result = await service.claimDeposit(OWNER_ID, dto);

      expect(result.message).toBe(
        'Reclamação do depósito registada. O cliente pode responder antes de um administrador decidir.',
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
            status: DisputeStatus.AWAITING_OWNER,
            responseDeadline: expect.any(Date),
            openedBy: OWNER_ID,
          }),
        }),
      );
      expect(notifierMock.opened).toHaveBeenCalledWith(DISPUTE_ID);
    });

    it('dá ao cliente 3 dias para responder', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeClaimableBooking());
      setupHappyTx();
      const before = Date.now();

      await service.claimDeposit(OWNER_ID, dto);

      const { data } = prisma.dispute.create.mock.calls[0][0] as {
        data: { responseDeadline: Date };
      };
      const days = (data.responseDeadline.getTime() - before) / (24 * HOUR_MS);
      expect(days).toBeGreaterThanOrEqual(3);
      expect(days).toBeLessThan(3.01);
    });

    it('aceita a reclamação depois de uma resolução parcial ter pago parte do aluguer', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeClaimableBooking({
          payment: makePayment({
            status: PaymentStatus.PARTIALLY_REFUNDED,
            depositStatus: DepositStatus.HELD,
          }),
        }),
      );
      setupHappyTx();

      await expect(service.claimDeposit(OWNER_ID, dto)).resolves.toBeDefined();
    });

    it('recusa provas que não foram carregadas por quem reclama', async () => {
      await expect(
        service.claimDeposit(OWNER_ID, {
          ...dto,
          evidenceUrls: [evidenceOf(CLIENT_ID)],
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'As provas têm de ser fotos que carregaste em /disputes/upload-evidence.',
        ),
      );
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
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
    const dto = { response: 'O equipamento foi entregue conforme acordado.' };

    /** A disputa como o respond() a lê: quem abriu, o estado e as partes. */
    const awaitingResponse = (overrides: Record<string, unknown> = {}) => ({
      openedBy: CLIENT_ID,
      status: DisputeStatus.AWAITING_OWNER,
      respondedAt: null,
      booking: { clientId: CLIENT_ID, ownerId: OWNER_ID },
      serviceBooking: null,
      ...overrides,
    });

    beforeEach(() => {
      prisma.dispute.findUnique.mockResolvedValue(awaitingResponse());
      prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
      prisma.dispute.findUniqueOrThrow.mockResolvedValue(
        makeDispute({ response: dto.response }),
      );
      prisma.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({
            role: where.id === ADMIN_ID ? UserRole.ADMIN : UserRole.CLIENT,
          }),
      );
    });

    describe('quem responde', () => {
      it('é o provider quando foi o cliente a abrir', async () => {
        const result = await service.respond(OWNER_ID, DISPUTE_ID, dto);

        expect(result.message).toBe(
          'Resposta registada. A disputa segue para análise.',
        );
      });

      it('é o cliente quando foi o provider a abrir', async () => {
        prisma.dispute.findUnique.mockResolvedValue(
          awaitingResponse({ openedBy: OWNER_ID }),
        );

        await expect(
          service.respond(CLIENT_ID, DISPUTE_ID, dto),
        ).resolves.toBeDefined();
      });

      it('é o cliente de um serviço quando o prestador abre a disputa', async () => {
        prisma.dispute.findUnique.mockResolvedValue(
          awaitingResponse({
            openedBy: OWNER_ID,
            booking: null,
            serviceBooking: { clientId: CLIENT_ID, providerId: OWNER_ID },
          }),
        );

        await expect(
          service.respond(CLIENT_ID, DISPUTE_ID, dto),
        ).resolves.toBeDefined();
      });

      it('nunca é quem abriu a disputa', async () => {
        await expect(
          service.respond(CLIENT_ID, DISPUTE_ID, dto),
        ).rejects.toThrow(
          new ForbiddenException(
            'Não tens permissão para responder a esta disputa.',
          ),
        );
        expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
      });

      it('nunca é alguém de fora da reserva', async () => {
        await expect(
          service.respond(STRANGER_ID, DISPUTE_ID, dto),
        ).rejects.toThrow(ForbiddenException);
      });

      it('pode ser um admin, em nome da outra parte, e fica registado como tal', async () => {
        await service.respond(ADMIN_ID, DISPUTE_ID, dto);

        expect(auditMock.record).toHaveBeenCalledWith({
          action: AuditAction.DISPUTE_RESPONDED,
          actorId: ADMIN_ID,
          targetType: 'Dispute',
          targetId: DISPUTE_ID,
          metadata: { onBehalfOfRespondent: true },
        });
      });
    });

    it('guarda a resposta, as provas e quem respondeu, e passa a disputa para análise', async () => {
      const evidenceUrls = [evidenceOf(OWNER_ID)];

      await service.respond(OWNER_ID, DISPUTE_ID, { ...dto, evidenceUrls });

      expect(prisma.dispute.updateMany).toHaveBeenCalledWith({
        where: {
          id: DISPUTE_ID,
          status: {
            in: [
              DisputeStatus.OPEN,
              DisputeStatus.AWAITING_OWNER,
              DisputeStatus.UNDER_REVIEW,
            ],
          },
          respondedAt: null,
        },
        data: {
          response: dto.response,
          responseEvidenceUrls: evidenceUrls,
          respondedAt: expect.any(Date) as Date,
          respondedBy: OWNER_ID,
          status: DisputeStatus.UNDER_REVIEW,
        },
      });
    });

    it('avisa quem abriu a disputa e fica em auditoria', async () => {
      await service.respond(OWNER_ID, DISPUTE_ID, dto);

      expect(notifierMock.responded).toHaveBeenCalledWith(DISPUTE_ID);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DISPUTE_RESPONDED,
          actorId: OWNER_ID,
          metadata: { onBehalfOfRespondent: false },
        }),
      );
    });

    it.each([
      ['a foto de outra pessoa', evidenceOf(CLIENT_ID)],
      ['um link de fora', 'https://exemplo.com/foto.jpg'],
      [
        'outra conta Cloudinary',
        `https://res.cloudinary.com/outra-conta/image/upload/v1/zuno/disputes/${OWNER_ID}/foto.jpg`,
      ],
      [
        'um endereço que não é https',
        evidenceOf(OWNER_ID).replace('https', 'http'),
      ],
    ])('recusa como prova %s', async (_label, url) => {
      await expect(
        service.respond(OWNER_ID, DISPUTE_ID, { ...dto, evidenceUrls: [url] }),
      ).rejects.toThrow(
        new BadRequestException(
          'As provas têm de ser fotos que carregaste em /disputes/upload-evidence.',
        ),
      );
      expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
    });

    it('aceita a resposta depois do prazo, enquanto a disputa não foi decidida', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        awaitingResponse({ status: DisputeStatus.UNDER_REVIEW }),
      );

      await expect(
        service.respond(OWNER_ID, DISPUTE_ID, dto),
      ).resolves.toBeDefined();
      expect(prisma.dispute.updateMany).toHaveBeenCalled();
    });

    it('recusa uma segunda resposta', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        awaitingResponse({
          status: DisputeStatus.UNDER_REVIEW,
          respondedAt: new Date(),
        }),
      );

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new BadRequestException('Esta disputa já não aceita resposta.'),
      );
      expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      DisputeStatus.RESOLVED_CLIENT,
      DisputeStatus.RESOLVED_OWNER,
      DisputeStatus.RESOLVED_PARTIAL,
      DisputeStatus.WITHDRAWN,
    ])('recusa responder a uma disputa %s', async (status) => {
      prisma.dispute.findUnique.mockResolvedValue(awaitingResponse({ status }));

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new BadRequestException('Esta disputa já não aceita resposta.'),
      );
      expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
    });

    it('não reabre uma disputa fechada entre a leitura e a escrita', async () => {
      prisma.dispute.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new BadRequestException('Esta disputa já não aceita resposta.'),
      );
      expect(auditMock.record).not.toHaveBeenCalled();
      expect(notifierMock.responded).not.toHaveBeenCalled();
    });

    it('responde 404 para uma disputa que não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.respond(OWNER_ID, DISPUTE_ID, dto)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });
  });

  describe('withdraw()', () => {
    /** A disputa como a transacção da retirada a relê. */
    const freshOpen = (overrides: Record<string, unknown> = {}) => ({
      status: DisputeStatus.AWAITING_OWNER,
      type: DisputeType.PAYMENT,
      booking: { id: BOOKING_ID, status: BookingStatus.DISPUTED },
      serviceBooking: null,
      ...overrides,
    });

    const setupWithdrawal = (fresh = freshOpen()) => {
      prisma.dispute.findUnique
        .mockResolvedValueOnce({ openedBy: CLIENT_ID })
        .mockResolvedValueOnce(fresh);
      prisma.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({
            role: where.id === ADMIN_ID ? UserRole.ADMIN : UserRole.CLIENT,
          }),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.serviceBooking.update.mockResolvedValue({});
      prisma.dispute.update.mockResolvedValue(
        makeDispute({ status: DisputeStatus.WITHDRAWN }),
      );
      passthroughTx();
    };

    it('quem abriu retira a disputa, sem mexer em dinheiro', async () => {
      setupWithdrawal();

      const result = await service.withdraw(CLIENT_ID, DISPUTE_ID, {});

      expect(result.data.status).toBe(DisputeStatus.WITHDRAWN);
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: DISPUTE_ID },
          data: {
            status: DisputeStatus.WITHDRAWN,
            resolution: 'Disputa retirada por quem a abriu.',
            closedAt: expect.any(Date) as Date,
            closedBy: CLIENT_ID,
          },
        }),
      );
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(payoutsMock.createPending).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('um aluguer em disputa de pagamento volta a estar à espera da entrega', async () => {
      setupWithdrawal();

      await service.withdraw(CLIENT_ID, DISPUTE_ID, {});

      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { status: BookingStatus.CONFIRMED },
      });
    });

    it('um aluguer em disputa de depósito volta a estar entregue', async () => {
      setupWithdrawal(freshOpen({ type: DisputeType.DEPOSIT }));

      await service.withdraw(CLIENT_ID, DISPUTE_ID, {});

      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { status: BookingStatus.ACTIVE },
      });
    });

    it.each([
      ['por começar', { startedAt: null, completedAt: null }, 'PENDING'],
      [
        'em execução',
        { startedAt: new Date(), completedAt: null },
        'IN_PROGRESS',
      ],
      [
        'concluído',
        { startedAt: new Date(), completedAt: new Date() },
        'COMPLETED',
      ],
    ])(
      'um serviço %s volta ao estado em que estava',
      async (_label, dates, status) => {
        setupWithdrawal(
          freshOpen({
            booking: null,
            serviceBooking: {
              id: SERVICE_BOOKING_ID,
              status: ServiceBookingStatus.DISPUTED,
              ...dates,
            },
          }),
        );

        await service.withdraw(CLIENT_ID, DISPUTE_ID, {});

        expect(prisma.serviceBooking.update).toHaveBeenCalledWith({
          where: { id: SERVICE_BOOKING_ID },
          data: { status },
        });
      },
    );

    it('guarda o motivo dado por quem retira', async () => {
      setupWithdrawal();

      await service.withdraw(CLIENT_ID, DISPUTE_ID, {
        reason: 'Falámos e ficou resolvido.',
      });

      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: 'Falámos e ficou resolvido.',
          }) as object,
        }),
      );
    });

    it('um admin arquiva a disputa, e fica registado que não foi quem a abriu', async () => {
      setupWithdrawal();

      await service.withdraw(ADMIN_ID, DISPUTE_ID, {});

      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: 'Disputa arquivada por um administrador.',
            closedBy: ADMIN_ID,
          }) as object,
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith({
        action: AuditAction.DISPUTE_WITHDRAWN,
        actorId: ADMIN_ID,
        targetType: 'Dispute',
        targetId: DISPUTE_ID,
        metadata: {
          reason: 'Disputa arquivada por um administrador.',
          byOpener: false,
        },
      });
    });

    it('avisa a outra parte', async () => {
      setupWithdrawal();

      await service.withdraw(CLIENT_ID, DISPUTE_ID, {});

      expect(notifierMock.withdrawn).toHaveBeenCalledWith(DISPUTE_ID, {
        opener: true,
      });
    });

    it('avisa também quem a abriu quando é um admin a arquivá-la', async () => {
      setupWithdrawal();

      await service.withdraw(ADMIN_ID, DISPUTE_ID, {});

      expect(notifierMock.withdrawn).toHaveBeenCalledWith(DISPUTE_ID, {
        opener: false,
      });
    });

    it('recusa a outra parte, que não a abriu', async () => {
      setupWithdrawal();

      await expect(service.withdraw(OWNER_ID, DISPUTE_ID, {})).rejects.toThrow(
        new ForbiddenException('Só quem abriu a disputa a pode retirar.'),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      DisputeStatus.RESOLVED_CLIENT,
      DisputeStatus.RESOLVED_OWNER,
      DisputeStatus.WITHDRAWN,
    ])(
      'recusa retirar uma disputa %s, relida na transacção',
      async (status) => {
        setupWithdrawal(freshOpen({ status }));

        await expect(
          service.withdraw(CLIENT_ID, DISPUTE_ID, {}),
        ).rejects.toThrow(
          new BadRequestException(
            'Só se retira uma disputa que ainda está por decidir.',
          ),
        );
        expect(prisma.booking.update).not.toHaveBeenCalled();
        expect(prisma.dispute.update).not.toHaveBeenCalled();
      },
    );

    it('recusa se a reserva já não está em disputa', async () => {
      setupWithdrawal(
        freshOpen({
          booking: { id: BOOKING_ID, status: BookingStatus.COMPLETED },
        }),
      );

      await expect(service.withdraw(CLIENT_ID, DISPUTE_ID, {})).rejects.toThrow(
        new BadRequestException('A reserva já não está em disputa.'),
      );
      expect(prisma.dispute.update).not.toHaveBeenCalled();
    });

    it('responde 404 para uma disputa que não existe', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.withdraw(CLIENT_ID, DISPUTE_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('quem perde a corrida com uma resolução recebe 409', async () => {
      setupWithdrawal();
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflito', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.withdraw(CLIENT_ID, DISPUTE_ID, {}),
      ).rejects.toMatchObject({ status: 409 });
      expect(auditMock.record).not.toHaveBeenCalled();
    });
  });

  describe('closeResponseWindows()', () => {
    const setupDue = (ids: string[]) => {
      prisma.dispute.findMany
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValue([]);
      prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    };

    it('procura as disputas à espera de resposta com o prazo vencido, da mais antiga para a mais recente', async () => {
      prisma.dispute.findMany.mockResolvedValue([]);

      const closed = await service.closeResponseWindows();

      expect(closed).toBe(0);
      const { where, orderBy } = prisma.dispute.findMany.mock.calls[0][0] as {
        where: { status: unknown; responseDeadline: { lte: Date } };
        orderBy: unknown;
      };
      expect(where.status).toEqual({
        in: [DisputeStatus.OPEN, DisputeStatus.AWAITING_OWNER],
      });
      expect(where.responseDeadline.lte.getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(orderBy).toEqual({ responseDeadline: 'asc' });
    });

    it('passa a disputa para análise, sem decidir por ninguém', async () => {
      setupDue([DISPUTE_ID]);

      const closed = await service.closeResponseWindows();

      expect(closed).toBe(1);
      expect(prisma.dispute.updateMany).toHaveBeenCalledWith({
        where: {
          id: DISPUTE_ID,
          status: { in: [DisputeStatus.OPEN, DisputeStatus.AWAITING_OWNER] },
          responseDeadline: { lte: expect.any(Date) as Date },
        },
        data: { status: DisputeStatus.UNDER_REVIEW },
      });
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('fica em auditoria como acção do sistema e avisa as duas partes', async () => {
      setupDue([DISPUTE_ID]);

      await service.closeResponseWindows();

      expect(auditMock.record).toHaveBeenCalledWith({
        action: AuditAction.DISPUTE_RESPONSE_WINDOW_CLOSED,
        actorId: 'system',
        targetType: 'Dispute',
        targetId: DISPUTE_ID,
      });
      expect(notifierMock.responseWindowClosed).toHaveBeenCalledWith(
        DISPUTE_ID,
      );
    });

    it('não mexe na disputa a que a outra parte respondeu entretanto', async () => {
      setupDue([DISPUTE_ID]);
      prisma.dispute.updateMany.mockResolvedValue({ count: 0 });

      await service.closeResponseWindows();

      expect(auditMock.record).not.toHaveBeenCalled();
      expect(notifierMock.responseWindowClosed).not.toHaveBeenCalled();
    });

    it('uma falha numa disputa não trava as outras', async () => {
      setupDue(['dispute-a', 'dispute-b']);
      prisma.dispute.updateMany
        .mockRejectedValueOnce(new Error('base em baixo'))
        .mockResolvedValueOnce({ count: 1 });

      const closed = await service.closeResponseWindows();

      expect(closed).toBe(1);
      expect(auditMock.record).toHaveBeenCalledTimes(1);
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
    prisma.dispute.update.mockResolvedValue(resolved);
  };

  describe('quando dois pedidos resolvem a mesma disputa ao mesmo tempo', () => {
    const serializationFailure = () =>
      new Prisma.PrismaClientKnownRequestError('conflito', {
        code: 'P2034',
        clientVersion: 'test',
      });

    it.each([
      ['a favor do cliente', () => service.resolveClient(ADMIN_ID, DISPUTE_ID)],
      ['a favor do provider', () => service.resolveOwner(ADMIN_ID, DISPUTE_ID)],
      [
        'parcialmente',
        () =>
          service.resolvePartial(ADMIN_ID, DISPUTE_ID, { refundPercent: 50 }),
      ],
    ])(
      'quem perde a corrida ao resolver %s recebe 409',
      async (_label, resolve) => {
        setupAdmin();
        prisma.dispute.findUnique.mockResolvedValue(makeDispute());
        prisma.$transaction.mockRejectedValue(serializationFailure());

        const attempt = resolve();

        await expect(attempt).rejects.toThrow(ApiException);
        await expect(attempt).rejects.toMatchObject({ status: 409 });
        expect(auditMock.record).not.toHaveBeenCalled();
      },
    );
  });

  describe('quando o admin é parte da reserva', () => {
    it.each([
      [
        'cliente',
        'a favor do cliente',
        { clientId: ADMIN_ID },
        () => service.resolveClient(ADMIN_ID, DISPUTE_ID),
      ],
      [
        'dono',
        'a favor do provider',
        { ownerId: ADMIN_ID },
        () => service.resolveOwner(ADMIN_ID, DISPUTE_ID),
      ],
      [
        'cliente',
        'parcialmente',
        { clientId: ADMIN_ID },
        () =>
          service.resolvePartial(ADMIN_ID, DISPUTE_ID, { refundPercent: 50 }),
      ],
    ])(
      'um admin que é o %s não resolve %s, antes de mexer no dinheiro',
      async (_role, _label, parties, resolve) => {
        setupAdmin();
        prisma.dispute.findUnique.mockResolvedValue(
          makeDispute({ payment: makePayment(parties) }),
        );

        await expect(resolve()).rejects.toMatchObject({
          status: 403,
          response: { errorCode: 'MONEY_CONTROL_VIOLATION' },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(auditMock.record).not.toHaveBeenCalled();
      },
    );
  });

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

    it('PAYMENT — cancela a booking e reembolsa o total, sem mexer no equipamento', async () => {
      setupResolution();

      const result = await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do cliente.');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
      );
      expect(prisma.equipment.update).not.toHaveBeenCalled();
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

    it('PAYMENT com depósito — paga o provider e a plataforma, e o depósito continua retido', async () => {
      setupResolution({
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      const result = await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do owner.');
      // ownerPayout 1350 + plataforma (2650 − 1000 − 1350 = 300). O depósito
      // de 1000 não sai do escrow: o equipamento ainda não voltou.
      expect(ledgerMock.record).toHaveBeenCalledTimes(2);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ party: LedgerParty.PROVIDER, amount: 1350 }),
      );
      expect(ledgerMock.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ party: LedgerParty.PLATFORM, amount: 300 }),
      );
      expect(payoutsMock.createPending).toHaveBeenCalledTimes(1);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: OWNER_ID,
          kind: PayoutKind.PROVIDER_PAYOUT,
          amount: 1350,
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: { status: PaymentStatus.RELEASED, releasedAt: expect.any(Date) },
      });
    });

    it('PAYMENT num aluguer — a entrega fica dada como feita e a reserva segue até à devolução', async () => {
      setupResolution({
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      // Com a reserva ACTIVE, o provider confirma a devolução ou reclama o
      // depósito, como depois de uma entrega confirmada pelo cliente.
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: {
          status: BookingStatus.ACTIVE,
          deliveryConfirmedAt: expect.any(Date),
        },
      });
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    it('PAYMENT num serviço — o serviço fica concluído', async () => {
      setupResolution({
        outer: makeDispute({
          bookingId: null,
          booking: null,
          serviceBookingId: SERVICE_BOOKING_ID,
          serviceBooking: {
            id: SERVICE_BOOKING_ID,
            status: ServiceBookingStatus.DISPUTED,
            clientId: CLIENT_ID,
            providerId: OWNER_ID,
          },
        }),
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

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SERVICE_BOOKING_ID },
          data: expect.objectContaining({
            status: ServiceBookingStatus.COMPLETED,
          }),
        }),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('PAYMENT sem depósito — paga o provider e a plataforma e não mexe no depósito', async () => {
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

      // provider 1350 + plataforma (1650 − 0 − 1350 = 300)
      expect(ledgerMock.record).toHaveBeenCalledTimes(2);
      expect(payoutsMock.createPending).toHaveBeenCalledTimes(1);
      expect(payoutsMock.createPending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: PayoutKind.PROVIDER_PAYOUT }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: { status: PaymentStatus.RELEASED, releasedAt: expect.any(Date) },
      });
    });

    it.each([DisputeStatus.AWAITING_OWNER, DisputeStatus.OPEN])(
      'recusa resolver uma disputa %s: a outra parte ainda pode responder',
      async (status) => {
        setupAdmin();
        prisma.dispute.findUnique.mockResolvedValue(makeDispute({ status }));

        await expect(
          service.resolveOwner(ADMIN_ID, DISPUTE_ID),
        ).rejects.toThrow(
          new BadRequestException(
            'A outra parte ainda pode responder a esta disputa. Só se resolve depois da resposta ou do fim do prazo.',
          ),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('recusa resolver uma disputa que foi retirada', async () => {
      setupAdmin();
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute({ status: DisputeStatus.WITHDRAWN }),
      );

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa foi retirada.'),
      );
    });

    it('fica com a data e o autor da resolução, e avisa as duas partes', async () => {
      setupResolution({
        resolved: makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
      });

      await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.RESOLVED_OWNER,
            closedAt: expect.any(Date),
            closedBy: ADMIN_ID,
          }),
        }),
      );
      expect(notifierMock.resolved).toHaveBeenCalledWith(DISPUTE_ID);
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
          }),
        }),
      );
    });

    it('PAYMENT com depósito — o depósito fica de fora da repartição e continua retido', async () => {
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
      // retido = 2650 − 1000 − 750 − 600 = 300. O depósito de 1000 não entra.
      expect(ledgerMock.recordMany).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({ party: LedgerParty.CLIENT, amount: 750 }),
        expect.objectContaining({ party: LedgerParty.PROVIDER, amount: 600 }),
        expect.objectContaining({ party: LedgerParty.PLATFORM, amount: 300 }),
      ]);
      expect(payoutsMock.createPending).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: PayoutKind.DEPOSIT_RETURN }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          refundedAt: expect.any(Date),
          releasedAt: expect.any(Date),
          refundAmount: 750,
          ownerPayout: 600,
        },
      });
      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: DisputeStatus.RESOLVED_PARTIAL,
            refundPercent: 50,
          }),
        }),
      );
    });

    it('PAYMENT num aluguer — a reserva fica activa até o equipamento voltar', async () => {
      setupResolution({
        resolved: makeDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 50,
        }),
      });

      await service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto);

      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: {
          status: BookingStatus.ACTIVE,
          deliveryConfirmedAt: expect.any(Date),
        },
      });
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
