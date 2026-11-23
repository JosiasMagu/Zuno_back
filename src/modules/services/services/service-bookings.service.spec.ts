import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditAction,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { issueProviderStrike } from '../../../shared/strikes/provider-strikes';
import {
  CancelledPaymentOutcome,
  EscrowRefundService,
} from '../../payments/services/escrow-refund.service';
import {
  UNCONFIRMED_REASON,
  UNPAID_REASON,
} from '../../payments/unpaid-reservation';
import { ServiceBookingNotifier } from './service-booking-notifier.service';
import { ServiceBookingsService } from './service-bookings.service';

jest.mock('../../../shared/strikes/provider-strikes');

const strikeMock = jest.mocked(issueProviderStrike);

const CLIENT_ID = 'client-uuid';
const PROVIDER_ID = 'provider-uuid';
const ADMIN_ID = 'admin-uuid';
const OUTSIDER_ID = 'outsider-uuid';
const BOOKING_ID = 'booking-uuid';
const PAYMENT_ID = 'payment-uuid';

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  providerId: PROVIDER_ID,
  serviceId: 'service-uuid',
  requestId: 'request-uuid',
  quoteId: 'quote-uuid',
  scheduledFor: null,
  isUrgent: false,
  serviceAmount: 5000,
  platformFee: 500,
  totalAmount: 5500,
  status: ServiceBookingStatus.PENDING,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  expiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  service: { id: 'service-uuid', title: 'Serviço' },
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  provider: { id: PROVIDER_ID, name: 'Provider', avatarUrl: null },
  payment: {
    id: PAYMENT_ID,
    status: PaymentStatus.HELD,
    receiptNumber: 'ZUNO-X',
    declaredAt: null,
  },
  ...overrides,
});

/** A reserva como cada transacção a relê antes de escrever. */
const makeFresh = (
  status: ServiceBookingStatus = ServiceBookingStatus.PENDING,
  paymentStatus: PaymentStatus | null = PaymentStatus.HELD,
) => ({
  status,
  payment: paymentStatus ? { id: PAYMENT_ID, status: paymentStatus } : null,
});

const PARTIES = {
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  providerId: PROVIDER_ID,
};

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  serviceBooking: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  payment: { findUnique: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
});

const audit = { record: jest.fn() };
const escrowRefunds = { settleCancelled: jest.fn() };
const notifier = {
  started: jest.fn(),
  completed: jest.fn(),
  cancelled: jest.fn(),
  expired: jest.fn(),
};

const serializationFailure = () =>
  new Prisma.PrismaClientKnownRequestError('conflito', {
    code: 'P2034',
    clientVersion: 'test',
  });

describe('ServiceBookingsService', () => {
  let service: ServiceBookingsService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma = makePrisma();
    prisma.$transaction.mockImplementation(
      (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    );
    prisma.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === ADMIN_ID
            ? { role: UserRole.ADMIN }
            : { role: UserRole.CLIENT },
        ),
    );
    strikeMock.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceBookingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EscrowRefundService, useValue: escrowRefunds },
        { provide: ServiceBookingNotifier, useValue: notifier },
      ],
    }).compile();
    service = module.get(ServiceBookingsService);
  });

  describe('findOne()', () => {
    it.each([
      ['o cliente', CLIENT_ID],
      ['o provider', PROVIDER_ID],
      ['um admin', ADMIN_ID],
    ])('mostra a reserva a %s', async (_label, userId) => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());

      const result = await service.findOne(userId, BOOKING_ID);

      expect(result.data.id).toBe(BOOKING_ID);
    });

    it('recusa quem não é parte da reserva nem admin', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(makeBooking());

      await expect(service.findOne(OUTSIDER_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('responde 404 para uma reserva que não existe', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('start()', () => {
    /** Primeira leitura: quem é o provider. Segunda, na transacção: o estado. */
    const setupStart = (fresh: ReturnType<typeof makeFresh> | null) => {
      prisma.serviceBooking.findUnique
        .mockResolvedValueOnce({ providerId: PROVIDER_ID })
        .mockResolvedValueOnce(fresh);
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.IN_PROGRESS }),
      );
    };

    it('o provider inicia uma reserva por começar com o dinheiro no escrow', async () => {
      setupStart(makeFresh());

      const result = await service.start(PROVIDER_ID, BOOKING_ID);

      expect(result.data.status).toBe(ServiceBookingStatus.IN_PROGRESS);
      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: {
            status: ServiceBookingStatus.IN_PROGRESS,
            startedAt: expect.any(Date) as Date,
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SERVICE_BOOKING_STARTED,
          actorId: PROVIDER_ID,
          targetId: BOOKING_ID,
        }),
      );
      expect(notifier.started).toHaveBeenCalledWith(BOOKING_ID);
    });

    it('recusa quem não é o provider da reserva, sem abrir transacção', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue({
        providerId: PROVIDER_ID,
      });

      await expect(service.start(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('responde 404 para uma reserva que não existe', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(null);

      await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      ['já foi iniciada', makeFresh(ServiceBookingStatus.IN_PROGRESS)],
      ['foi cancelada entretanto', makeFresh(ServiceBookingStatus.CANCELLED)],
      [
        'expirou',
        makeFresh(ServiceBookingStatus.EXPIRED, PaymentStatus.FAILED),
      ],
      [
        'ainda não foi paga',
        makeFresh(ServiceBookingStatus.PENDING, PaymentStatus.PENDING),
      ],
      [
        'teve o pagamento devolvido entretanto',
        makeFresh(ServiceBookingStatus.PENDING, PaymentStatus.REFUNDED),
      ],
      ['não tem pagamento', makeFresh(ServiceBookingStatus.PENDING, null)],
    ])(
      'recusa quando a reserva, relida na transacção, %s',
      async (_label, fresh) => {
        setupStart(fresh);

        await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
          BadRequestException,
        );

        expect(prisma.serviceBooking.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(notifier.started).not.toHaveBeenCalled();
      },
    );

    it('troca o conflito de escrita do Postgres por um 400 limpo', async () => {
      setupStart(makeFresh());
      prisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(service.start(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('complete()', () => {
    const setupComplete = (status: ServiceBookingStatus) => {
      prisma.serviceBooking.findUnique
        .mockResolvedValueOnce({ providerId: PROVIDER_ID })
        .mockResolvedValueOnce({ status });
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({
          status: ServiceBookingStatus.COMPLETED,
          completedAt: new Date(),
        }),
      );
    };

    it('o provider dá por concluída uma reserva em execução', async () => {
      setupComplete(ServiceBookingStatus.IN_PROGRESS);

      const result = await service.complete(PROVIDER_ID, BOOKING_ID);

      expect(result.data.status).toBe(ServiceBookingStatus.COMPLETED);
      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: ServiceBookingStatus.COMPLETED,
            completedAt: expect.any(Date) as Date,
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SERVICE_BOOKING_COMPLETED,
          actorId: PROVIDER_ID,
        }),
      );
      expect(notifier.completed).toHaveBeenCalledWith(BOOKING_ID);
    });

    it('diz ao cliente até quando tem para confirmar', async () => {
      setupComplete(ServiceBookingStatus.IN_PROGRESS);
      const completedAt = new Date('2030-06-01T10:00:00.000Z');
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.COMPLETED, completedAt }),
      );

      const result = await service.complete(PROVIDER_ID, BOOKING_ID);

      expect(result.data.autoReleaseAt).toEqual(
        new Date('2030-06-04T10:00:00.000Z'),
      );
    });

    it('recusa quem não é o provider da reserva', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue({
        providerId: PROVIDER_ID,
      });

      await expect(service.complete(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each([
      ServiceBookingStatus.PENDING,
      ServiceBookingStatus.COMPLETED,
      ServiceBookingStatus.CANCELLED,
      ServiceBookingStatus.DISPUTED,
    ])('recusa uma reserva %s, relida na transacção', async (status) => {
      setupComplete(status);

      await expect(service.complete(PROVIDER_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.serviceBooking.update).not.toHaveBeenCalled();
      expect(notifier.completed).not.toHaveBeenCalled();
    });
  });

  describe('cancel()', () => {
    /** Primeira leitura: as partes. Segunda, na transacção: o estado. */
    const setupCancel = (
      fresh: ReturnType<typeof makeFresh> | null,
      outcome = CancelledPaymentOutcome.REFUNDED,
    ) => {
      prisma.serviceBooking.findUnique
        .mockResolvedValueOnce(PARTIES)
        .mockResolvedValueOnce(fresh);
      escrowRefunds.settleCancelled.mockResolvedValue(outcome);
      prisma.serviceBooking.update.mockResolvedValue(
        makeBooking({ status: ServiceBookingStatus.CANCELLED }),
      );
    };

    const auditOf = (action: AuditAction) =>
      audit.record.mock.calls
        .map(([entry]: [{ action: AuditAction }]) => entry)
        .find((entry) => entry.action === action);

    it('responde 404 para uma reserva que não existe', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(null);

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('recusa quem não é parte da reserva nem admin', async () => {
      prisma.serviceBooking.findUnique.mockResolvedValue(PARTIES);

      await expect(service.cancel(OUTSIDER_ID, BOOKING_ID, {})).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('antes de o dinheiro entrar', () => {
      it.each([
        ['o cliente', CLIENT_ID, 'CLIENT'],
        ['o provider', PROVIDER_ID, 'PROVIDER'],
        ['um admin', ADMIN_ID, 'ADMIN'],
      ])(
        '%s cancela e o pagamento fica anulado',
        async (_label, userId, party) => {
          setupCancel(
            makeFresh(ServiceBookingStatus.PENDING, PaymentStatus.PENDING),
            CancelledPaymentOutcome.VOIDED,
          );

          const result = await service.cancel(userId, BOOKING_ID, {});

          expect(result.message).toBe('Reserva cancelada com sucesso.');
          expect(escrowRefunds.settleCancelled).toHaveBeenCalledWith(
            prisma,
            PAYMENT_ID,
            {
              actorId: userId,
              reason: 'Reembolso total por cancelamento do serviço.',
            },
          );
          expect(auditOf(AuditAction.SERVICE_BOOKING_CANCELLED)).toMatchObject({
            actorId: userId,
            metadata: { cancelledBy: party, paymentOutcome: 'VOIDED' },
          });
        },
      );

      it('o provider não leva strike: não havia dinheiro do cliente preso', async () => {
        setupCancel(
          makeFresh(ServiceBookingStatus.PENDING, PaymentStatus.PENDING),
          CancelledPaymentOutcome.VOIDED,
        );

        await service.cancel(PROVIDER_ID, BOOKING_ID, {});

        expect(strikeMock).not.toHaveBeenCalled();
        expect(auditOf(AuditAction.PROVIDER_STRIKE_ISSUED)).toBeUndefined();
      });

      it('cancela uma reserva sem pagamento nenhum, sem tocar no escrow', async () => {
        setupCancel(makeFresh(ServiceBookingStatus.PENDING, null));

        await service.cancel(CLIENT_ID, BOOKING_ID, {});

        expect(escrowRefunds.settleCancelled).not.toHaveBeenCalled();
        expect(auditOf(AuditAction.SERVICE_BOOKING_CANCELLED)).toMatchObject({
          metadata: { paymentOutcome: 'NOTHING_TO_SETTLE' },
        });
      });
    });

    describe('com o serviço pago e por começar', () => {
      it('o cliente cancela e recebe tudo de volta', async () => {
        setupCancel(makeFresh());

        const result = await service.cancel(CLIENT_ID, BOOKING_ID, {});

        expect(result.message).toBe(
          'Reserva cancelada. O valor pago vai ser devolvido ao cliente.',
        );
        expect(escrowRefunds.settleCancelled).toHaveBeenCalledTimes(1);
        expect(strikeMock).not.toHaveBeenCalled();
        expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: BOOKING_ID },
            data: expect.objectContaining({
              status: ServiceBookingStatus.CANCELLED,
              cancelledAt: expect.any(Date) as Date,
            }) as object,
          }),
        );
        // A auditoria vai na transacção do reembolso.
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.SERVICE_BOOKING_CANCELLED,
            metadata: {
              reason: null,
              cancelledBy: 'CLIENT',
              paymentOutcome: 'REFUNDED',
            },
          }),
          prisma,
        );
      });

      it('o provider cancela: o cliente recebe tudo e o provider leva strike', async () => {
        setupCancel(makeFresh());

        await service.cancel(PROVIDER_ID, BOOKING_ID, {});

        expect(strikeMock).toHaveBeenCalledWith(prisma, {
          providerId: PROVIDER_ID,
          serviceBookingId: BOOKING_ID,
          reason: 'Cancelamento de serviço já pago.',
        });
        expect(auditOf(AuditAction.PROVIDER_STRIKE_ISSUED)).toMatchObject({
          actorId: PROVIDER_ID,
          targetType: 'User',
          targetId: PROVIDER_ID,
          metadata: { serviceBookingId: BOOKING_ID },
        });
      });

      it('um admin cancela sem strike para ninguém', async () => {
        setupCancel(makeFresh());

        await service.cancel(ADMIN_ID, BOOKING_ID, {});

        expect(escrowRefunds.settleCancelled).toHaveBeenCalledTimes(1);
        expect(strikeMock).not.toHaveBeenCalled();
      });

      it('regista em auditoria a suspensão dos anúncios ao terceiro strike', async () => {
        const suspendedUntil = new Date('2030-07-01T10:00:00.000Z');
        setupCancel(makeFresh());
        strikeMock.mockResolvedValue(suspendedUntil);

        await service.cancel(PROVIDER_ID, BOOKING_ID, {});

        expect(auditOf(AuditAction.PROVIDER_LISTINGS_SUSPENDED)).toMatchObject({
          actorId: 'system',
          targetId: PROVIDER_ID,
          metadata: {
            serviceBookingId: BOOKING_ID,
            suspendedUntil: '2030-07-01T10:00:00.000Z',
          },
        });
      });
    });

    describe('com o serviço já começado', () => {
      it('recusa o cliente e manda-o para a disputa, sem mexer em nada', async () => {
        setupCancel(makeFresh(ServiceBookingStatus.IN_PROGRESS));

        const attempt = service.cancel(CLIENT_ID, BOOKING_ID, {});

        await expect(attempt).rejects.toThrow(ApiException);
        await expect(attempt).rejects.toMatchObject({
          response: { errorCode: ErrorCode.SERVICE_BOOKING_IN_PROGRESS },
        });
        expect(escrowRefunds.settleCancelled).not.toHaveBeenCalled();
        expect(prisma.serviceBooking.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('o provider desiste: devolve tudo ao cliente e leva strike', async () => {
        setupCancel(makeFresh(ServiceBookingStatus.IN_PROGRESS));

        await service.cancel(PROVIDER_ID, BOOKING_ID, {});

        expect(escrowRefunds.settleCancelled).toHaveBeenCalledTimes(1);
        expect(strikeMock).toHaveBeenCalledTimes(1);
      });

      it('um admin cancela e o cliente recebe tudo de volta', async () => {
        setupCancel(makeFresh(ServiceBookingStatus.IN_PROGRESS));

        const result = await service.cancel(ADMIN_ID, BOOKING_ID, {});

        expect(result.message).toContain('vai ser devolvido');
        expect(strikeMock).not.toHaveBeenCalled();
      });
    });

    describe('quando já não há nada a cancelar', () => {
      it.each([
        ServiceBookingStatus.COMPLETED,
        ServiceBookingStatus.CANCELLED,
        ServiceBookingStatus.DISPUTED,
        ServiceBookingStatus.EXPIRED,
      ])('recusa uma reserva %s, mesmo a um admin', async (status) => {
        setupCancel(makeFresh(status));

        await expect(service.cancel(ADMIN_ID, BOOKING_ID, {})).rejects.toThrow(
          BadRequestException,
        );

        expect(escrowRefunds.settleCancelled).not.toHaveBeenCalled();
        expect(prisma.serviceBooking.update).not.toHaveBeenCalled();
      });

      it.each([
        PaymentStatus.RELEASED,
        PaymentStatus.REFUNDED,
        PaymentStatus.PARTIALLY_REFUNDED,
      ])('recusa quando o pagamento já está %s', async (paymentStatus) => {
        setupCancel(makeFresh(ServiceBookingStatus.IN_PROGRESS, paymentStatus));

        await expect(service.cancel(ADMIN_ID, BOOKING_ID, {})).rejects.toThrow(
          BadRequestException,
        );

        expect(escrowRefunds.settleCancelled).not.toHaveBeenCalled();
      });

      it('responde 404 se a reserva desapareceu entre a leitura e a transacção', async () => {
        setupCancel(null);

        await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    it('guarda o motivo sem espaços à volta', async () => {
      setupCancel(makeFresh());

      await service.cancel(CLIENT_ID, BOOKING_ID, {
        reason: '  Mudei de planos.  ',
      });

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationReason: 'Mudei de planos.',
          }) as object,
        }),
      );
    });

    it('guarda null quando não é dado motivo', async () => {
      setupCancel(makeFresh());

      await service.cancel(CLIENT_ID, BOOKING_ID, { reason: '   ' });

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationReason: null,
          }) as object,
        }),
      );
    });

    it('avisa a outra parte', async () => {
      setupCancel(makeFresh());

      await service.cancel(PROVIDER_ID, BOOKING_ID, {});

      expect(notifier.cancelled).toHaveBeenCalledWith(BOOKING_ID, 'PROVIDER');
    });

    it('troca o conflito de escrita do Postgres por um 400 limpo', async () => {
      setupCancel(makeFresh());
      prisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(service.cancel(CLIENT_ID, BOOKING_ID, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifier.cancelled).not.toHaveBeenCalled();
    });
  });

  describe('expireUnpaid()', () => {
    const setupDue = (ids: string[]) => {
      prisma.serviceBooking.findMany
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValue([]);
      prisma.payment.findUnique.mockResolvedValue({
        declaredAt: null,
        declaredReference: null,
      });
      prisma.serviceBooking.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    };

    it('procura reservas por começar, com o prazo vencido e sem dinheiro no escrow', async () => {
      prisma.serviceBooking.findMany.mockResolvedValue([]);

      const expired = await service.expireUnpaid();

      expect(expired).toBe(0);
      const { where, orderBy } =
        prisma.serviceBooking.findMany.mock.calls[0][0];
      expect(where.status).toBe(ServiceBookingStatus.PENDING);
      expect(where.expiresAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
      expect(where.OR).toEqual([
        { payment: null },
        {
          payment: {
            status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
        },
      ]);
      expect(orderBy).toEqual({ expiresAt: 'asc' });
    });

    it('expira a reserva, anula o pagamento e avisa as partes', async () => {
      setupDue([BOOKING_ID]);

      const expired = await service.expireUnpaid();

      expect(expired).toBe(1);
      expect(prisma.serviceBooking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: ServiceBookingStatus.EXPIRED,
            cancelledAt: expect.any(Date) as Date,
            cancellationReason: UNPAID_REASON,
          },
        }),
      );
      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { serviceBookingId: BOOKING_ID, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      expect(notifier.expired).toHaveBeenCalledWith(BOOKING_ID, false);
    });

    it('fica em auditoria como acção do sistema', async () => {
      setupDue([BOOKING_ID]);

      await service.expireUnpaid();

      expect(audit.record).toHaveBeenCalledWith({
        action: AuditAction.SERVICE_BOOKING_EXPIRED,
        actorId: 'system',
        targetType: 'ServiceBooking',
        targetId: BOOKING_ID,
        metadata: { declaredReference: null },
      });
    });

    it('guarda a referência declarada quando o admin não confirmou a tempo', async () => {
      setupDue([BOOKING_ID]);
      prisma.payment.findUnique.mockResolvedValue({
        declaredAt: new Date(),
        declaredReference: 'CHK7H3ABCD',
      });

      await service.expireUnpaid();

      expect(prisma.serviceBooking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationReason: UNCONFIRMED_REASON,
          }) as object,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { declaredReference: 'CHK7H3ABCD' },
        }),
      );
      expect(notifier.expired).toHaveBeenCalledWith(BOOKING_ID, true);
    });

    it('não expira a reserva cujo pagamento entrou entretanto', async () => {
      setupDue([BOOKING_ID]);
      prisma.serviceBooking.updateMany.mockResolvedValue({ count: 0 });

      await service.expireUnpaid();

      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifier.expired).not.toHaveBeenCalled();
    });

    it('uma falha numa reserva não trava as outras', async () => {
      setupDue(['booking-a', 'booking-b']);
      prisma.serviceBooking.updateMany
        .mockRejectedValueOnce(new Error('base em baixo'))
        .mockResolvedValueOnce({ count: 1 });

      const expired = await service.expireUnpaid();

      expect(expired).toBe(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'booking-b' }),
      );
    });
  });

  describe('findMine() / findForProvider()', () => {
    beforeEach(() => {
      prisma.serviceBooking.findMany.mockResolvedValue([makeBooking()]);
      prisma.serviceBooking.count.mockResolvedValue(11);
    });

    it('lista as reservas do cliente, com paginação', async () => {
      const result = await service.findMine(CLIENT_ID, { page: 2, limit: 5 });

      expect(prisma.serviceBooking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: CLIENT_ID },
          skip: 5,
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result.meta).toEqual({
        page: 2,
        limit: 5,
        total: 11,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('lista as reservas do provider, filtradas por estado', async () => {
      await service.findForProvider(PROVIDER_ID, {
        status: ServiceBookingStatus.IN_PROGRESS,
      });

      expect(prisma.serviceBooking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            providerId: PROVIDER_ID,
            status: ServiceBookingStatus.IN_PROGRESS,
          },
        }),
      );
    });

    it('mostra o prazo de pagamento e se o cliente já declarou que pagou', async () => {
      const expiresAt = new Date('2030-06-02T10:00:00.000Z');
      const declaredAt = new Date('2030-06-01T12:00:00.000Z');
      prisma.serviceBooking.findMany.mockResolvedValue([
        makeBooking({
          expiresAt,
          payment: {
            id: PAYMENT_ID,
            status: PaymentStatus.PENDING,
            receiptNumber: 'ZUNO-X',
            declaredAt,
          },
        }),
      ]);

      const result = await service.findMine(CLIENT_ID, {});

      expect(result.data[0].expiresAt).toEqual(expiresAt);
      expect(result.data[0].payment?.declaredAt).toEqual(declaredAt);
      expect(result.data[0].autoReleaseAt).toBeNull();
    });
  });
});
