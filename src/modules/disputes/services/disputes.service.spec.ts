import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  DisputeReason,
  DisputeStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { DisputesService } from './disputes.service';
import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';

const auditMock = { record: jest.fn() };

// CONSTANTES DE TESTE

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const DISPUTE_ID = 'dispute-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';

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
  ownerPayout: null,
  currency: 'MZN',
  method: 'MPESA',
  mpesaReference: null,
  status: PaymentStatus.HELD,
  heldAt: new Date(),
  releasedAt: null,
  refundedAt: null,
  refundAmount: null,
  depositReleasedAt: null,
  depositHeldAmount: null,
  receiptNumber: 'REC-001',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  equipmentId: 'equipment-uuid-001',
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
  paymentId: PAYMENT_ID,
  openedBy: CLIENT_ID,
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
    status: BookingStatus.DISPUTED,
    startDate: new Date(),
    endDate: new Date(),
    clientId: CLIENT_ID,
    ownerId: OWNER_ID,
  },
  payment: {
    id: PAYMENT_ID,
    status: PaymentStatus.HELD,
    totalCharged: new Prisma.Decimal(2650),
    receiptNumber: 'REC-001',
    refundAmount: null,
  },
  opener: {
    id: CLIENT_ID,
    name: 'Cliente',
    avatarUrl: null,
  },
  ...overrides,
});

// MOCK DO PRISMA

const makePrismaMock = () => ({
  user: { findUnique: jest.fn() },
  booking: { findUnique: jest.fn(), update: jest.fn() },
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

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditMock },
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
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );
      prisma.booking.update.mockResolvedValue({});
      prisma.dispute.create.mockResolvedValue(disputeResult);
    };

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

    it('rejeita disputa em pagamento RELEASED — escrow ja libertado', async () => {
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

    const disputeWithOwner = makeDispute({
      booking: {
        id: BOOKING_ID,
        status: BookingStatus.DISPUTED,
        startDate: new Date(),
        endDate: new Date(),
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      },
    });

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

  // resolveClient() - dinheiro volta ao cliente

  describe('resolveClient()', () => {
    const setupAdminAndDispute = (
      disputeOverrides: Record<string, unknown> = {},
    ) => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute(disputeOverrides),
      );
    };

    const setupHappyTx = (
      disputeResult = makeDispute({ status: DisputeStatus.RESOLVED_CLIENT }),
    ) => {
      prisma.$transaction.mockResolvedValue([{}, {}, disputeResult]);
    };

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
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida', async () => {
      setupAdminAndDispute({ status: DisputeStatus.RESOLVED_CLIENT });

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento está PENDING', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.PENDING,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução a favor do cliente.',
        ),
      );
    });

    it('lança BadRequestException se pagamento já está REFUNDED', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.REFUNDED,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });

      await expect(service.resolveClient(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('resolve a favor do cliente com sucesso — transacção com 3 operações', async () => {
      setupAdminAndDispute();
      setupHappyTx();

      const result = await service.resolveClient(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do cliente.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // A transaccao deve ter 3 operacoes (booking update, payment update, dispute update)
      const txArg = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(txArg).toHaveLength(3);
    });

    it('também funciona com pagamento RELEASED', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.RELEASED,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });
      setupHappyTx();

      const result = await service.resolveClient(ADMIN_ID, DISPUTE_ID);
      expect(result.message).toBe('Disputa resolvida a favor do cliente.');
    });
  });

  // resolveOwner() - dinheiro vai para o owner

  describe('resolveOwner()', () => {
    const setupAdminAndDispute = (
      disputeOverrides: Record<string, unknown> = {},
    ) => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute(disputeOverrides),
      );
    };

    const setupHappyTx = (
      disputeResult = makeDispute({ status: DisputeStatus.RESOLVED_OWNER }),
    ) => {
      prisma.$transaction.mockResolvedValue([{}, {}, disputeResult]);
    };

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
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new NotFoundException('Disputa não encontrada.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida (RESOLVED_OWNER)', async () => {
      setupAdminAndDispute({ status: DisputeStatus.RESOLVED_OWNER });

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se disputa já foi resolvida (RESOLVED_PARTIAL)', async () => {
      setupAdminAndDispute({ status: DisputeStatus.RESOLVED_PARTIAL });

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento está PENDING', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.PENDING,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });

      await expect(service.resolveOwner(ADMIN_ID, DISPUTE_ID)).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução a favor do owner.',
        ),
      );
    });

    it('resolve a favor do owner com sucesso — pagamento HELD → RELEASED', async () => {
      setupAdminAndDispute();
      setupHappyTx();

      const result = await service.resolveOwner(ADMIN_ID, DISPUTE_ID);

      expect(result.message).toBe('Disputa resolvida a favor do owner.');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const txArg = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(txArg).toHaveLength(3);
    });

    it('resolve com sucesso mesmo com pagamento já RELEASED (update vazio — comportamento documentado)', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.RELEASED,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });
      setupHappyTx();

      const result = await service.resolveOwner(ADMIN_ID, DISPUTE_ID);
      expect(result.message).toBe('Disputa resolvida a favor do owner.');
    });
  });

  // resolvePartial() - reembolso parcial

  describe('resolvePartial()', () => {
    const dto = { refundPercent: 50 };

    const setupAdminAndDispute = (
      disputeOverrides: Record<string, unknown> = {},
    ) => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(
        makeDispute(disputeOverrides),
      );
    };

    const setupHappyTx = (
      disputeResult = makeDispute({
        status: DisputeStatus.RESOLVED_PARTIAL,
        refundPercent: 50,
      }),
    ) => {
      prisma.$transaction.mockResolvedValue([{}, {}, disputeResult]);
    };

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
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(new NotFoundException('Disputa não encontrada.'));
    });

    it('lança BadRequestException se disputa já foi resolvida', async () => {
      setupAdminAndDispute({ status: DisputeStatus.RESOLVED_PARTIAL });

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException('Esta disputa já foi resolvida.'),
      );
    });

    it('lança BadRequestException se pagamento não está válido', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.FAILED,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });

      await expect(
        service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução parcial.',
        ),
      );
    });

    it('calcula refundAmount correctamente — 50% de 2650 = 1325', async () => {
      setupAdminAndDispute();
      setupHappyTx();

      await service.resolvePartial(ADMIN_ID, DISPUTE_ID, { refundPercent: 50 });

      const txArg = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(txArg).toHaveLength(3);
    });

    it('calcula refundAmount correctamente — 30% de 2650 = 795', async () => {
      setupAdminAndDispute();
      // 2650 * 0.30 = 795
      setupHappyTx(
        makeDispute({
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: 30,
        }),
      );

      const result = await service.resolvePartial(ADMIN_ID, DISPUTE_ID, {
        refundPercent: 30,
      });
      expect(result.message).toBe(
        'Disputa resolvida parcialmente com sucesso.',
      );
    });

    it('resolve parcialmente com sucesso', async () => {
      setupAdminAndDispute();
      setupHappyTx();

      const result = await service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto);

      expect(result.message).toBe(
        'Disputa resolvida parcialmente com sucesso.',
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('resolve com pagamento RELEASED também', async () => {
      setupAdminAndDispute({
        payment: {
          id: PAYMENT_ID,
          status: PaymentStatus.RELEASED,
          totalCharged: new Prisma.Decimal(2650),
          receiptNumber: 'REC-001',
          refundAmount: null,
        },
      });
      setupHappyTx();

      const result = await service.resolvePartial(ADMIN_ID, DISPUTE_ID, dto);
      expect(result.message).toBe(
        'Disputa resolvida parcialmente com sucesso.',
      );
    });
  });
});
