import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  PayoutKind,
  PayoutStatus,
  Prisma,
  ProviderOperationKind,
  ProviderOperationStatus,
  UserRole,
} from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PaymentNotifier } from './payment-notifier.service';
import { PayoutsService } from './payouts.service';

const ADMIN_ID = 'admin-uuid-001';
const CLIENT_ID = 'client-uuid-001';
const PAYOUT_ID = 'payout-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';

const REGISTERED_MSISDN = '+258840000902';
const OTHER_MSISDN = '+258850000111';
const PAYER_MSISDN = '+258870000333';

const auditMock = { record: jest.fn() };
const notifierMock = { payoutExecuted: jest.fn(), payoutFailed: jest.fn() };
let settings: Record<string, string | undefined> = {};
const configMock = { get: jest.fn((key: string) => settings[key]) };

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  payment: { findUnique: jest.fn() },
  providerOperation: { create: jest.fn() },
  payout: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
});

const makePayout = (overrides: Record<string, unknown> = {}) => ({
  id: PAYOUT_ID,
  paymentId: PAYMENT_ID,
  recipientId: CLIENT_ID,
  kind: PayoutKind.CLIENT_REFUND,
  amount: new Prisma.Decimal(5500),
  msisdn: REGISTERED_MSISDN,
  status: PayoutStatus.PENDING,
  mpesaReference: null,
  executedById: null,
  executedAt: null,
  failReason: null,
  approvedAt: null,
  createdAt: new Date('2030-06-01T10:00:00.000Z'),
  updatedAt: new Date('2030-06-01T10:00:00.000Z'),
  recipient: {
    id: CLIENT_ID,
    name: 'Cliente',
    phone: REGISTERED_MSISDN,
    payoutMsisdn: REGISTERED_MSISDN,
  },
  payment: {
    id: PAYMENT_ID,
    receiptNumber: 'ZUNO-1-0001',
    bookingId: 'booking-uuid-001',
    serviceBookingId: null,
    heldById: 'outro-admin',
  },
  ...overrides,
});

const serializationFailure = () =>
  new Prisma.PrismaClientKnownRequestError('conflito', {
    code: 'P2034',
    clientVersion: 'test',
  });

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('referência repetida', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('PayoutsService', () => {
  let service: PayoutsService;
  let prisma: ReturnType<typeof makePrisma>;
  const tx = () => prisma as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    jest.resetAllMocks();
    settings = {};
    configMock.get.mockImplementation((key: string) => settings[key]);
    prisma = makePrisma();
    prisma.$transaction.mockImplementation(
      (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    );
    prisma.user.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === ADMIN_ID
            ? { id: ADMIN_ID, role: UserRole.ADMIN }
            : { id: where.id, role: UserRole.CLIENT },
        ),
    );
    service = new PayoutsService(
      prisma as unknown as PrismaService,
      auditMock as unknown as AuditService,
      configMock as unknown as ConfigService,
      notifierMock as unknown as PaymentNotifier,
    );
  });

  describe('createPending', () => {
    const input = {
      paymentId: PAYMENT_ID,
      recipientId: CLIENT_ID,
      kind: PayoutKind.CLIENT_REFUND,
      amount: 5500,
    };

    it('queues the payout to the number the recipient registered for receiving', async () => {
      prisma.user.findUnique.mockResolvedValue({
        payoutMsisdn: OTHER_MSISDN,
        phone: REGISTERED_MSISDN,
      });

      await service.createPending(tx(), input);

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: {
          paymentId: PAYMENT_ID,
          recipientId: CLIENT_ID,
          kind: PayoutKind.CLIENT_REFUND,
          amount: 5500,
          msisdn: OTHER_MSISDN,
          status: PayoutStatus.PENDING,
        },
      });
    });

    it('falls back to the account phone when no receiving number was set', async () => {
      prisma.user.findUnique.mockResolvedValue({
        payoutMsisdn: null,
        phone: REGISTERED_MSISDN,
      });

      await service.createPending(tx(), input);

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ msisdn: REGISTERED_MSISDN }) as object,
      });
    });

    it.each([PayoutKind.CLIENT_REFUND, PayoutKind.DEPOSIT_RETURN])(
      'sends a %s back to the number that paid',
      async (kind) => {
        prisma.user.findUnique.mockResolvedValue({
          payoutMsisdn: OTHER_MSISDN,
          phone: REGISTERED_MSISDN,
        });
        prisma.payment.findUnique.mockResolvedValue({
          payerMsisdn: PAYER_MSISDN,
        });

        await service.createPending(tx(), { ...input, kind });

        expect(prisma.payment.findUnique).toHaveBeenCalledWith({
          where: { id: PAYMENT_ID },
          select: { payerMsisdn: true },
        });
        expect(prisma.payout.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ msisdn: PAYER_MSISDN }) as object,
        });
      },
    );

    it('falls back to the receiving number when the payer is unknown', async () => {
      prisma.user.findUnique.mockResolvedValue({
        payoutMsisdn: OTHER_MSISDN,
        phone: REGISTERED_MSISDN,
      });
      prisma.payment.findUnique.mockResolvedValue({ payerMsisdn: null });

      await service.createPending(tx(), input);

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ msisdn: OTHER_MSISDN }) as object,
      });
    });

    it.each([PayoutKind.PROVIDER_PAYOUT, PayoutKind.DEPOSIT_CLAIM])(
      'sends a %s to the receiving number, without looking at the payer',
      async (kind) => {
        prisma.user.findUnique.mockResolvedValue({
          payoutMsisdn: OTHER_MSISDN,
          phone: REGISTERED_MSISDN,
        });

        await service.createPending(tx(), { ...input, kind });

        expect(prisma.payment.findUnique).not.toHaveBeenCalled();
        expect(prisma.payout.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ msisdn: OTHER_MSISDN }) as object,
        });
      },
    );

    it('rounds the amount to cents', async () => {
      prisma.user.findUnique.mockResolvedValue({
        payoutMsisdn: null,
        phone: REGISTERED_MSISDN,
      });

      await service.createPending(tx(), { ...input, amount: 1499.999 });

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 1500 }) as object,
      });
    });

    it.each([0, -10, 0.004])(
      'creates nothing for an amount of %s',
      async (amount) => {
        const payout = await service.createPending(tx(), { ...input, amount });

        expect(payout).toBeNull();
        expect(prisma.payout.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('execute', () => {
    const dto = { mpesaReference: 'QGH7RT51XK' };

    const setupExecutable = (payout = makePayout()) => {
      prisma.payout.findUnique.mockResolvedValue(payout);
      prisma.payout.findFirst.mockResolvedValue(null);
      prisma.payout.update.mockResolvedValue(
        makePayout({
          status: PayoutStatus.EXECUTED,
          mpesaReference: 'QGH7RT51XK',
          executedById: ADMIN_ID,
        }),
      );
    };

    it('marks the payout executed with the reference, the number and who did it', async () => {
      setupExecutable();

      const result = await service.execute(ADMIN_ID, PAYOUT_ID, dto);

      expect(result.data.status).toBe(PayoutStatus.EXECUTED);
      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PAYOUT_ID },
          data: {
            status: PayoutStatus.EXECUTED,
            msisdn: REGISTERED_MSISDN,
            mpesaReference: 'QGH7RT51XK',
            executedById: ADMIN_ID,
            executedAt: expect.any(Date) as Date,
            failReason: null,
          },
        }),
      );
    });

    it('records where the money went, to the registered number, inside the transaction', async () => {
      setupExecutable();

      await service.execute(ADMIN_ID, PAYOUT_ID, dto);

      expect(auditMock.record).toHaveBeenCalledWith(
        {
          action: AuditAction.PAYOUT_EXECUTED,
          actorId: ADMIN_ID,
          targetType: 'Payout',
          targetId: PAYOUT_ID,
          amount: new Prisma.Decimal(5500),
          metadata: {
            mpesaReference: 'QGH7RT51XK',
            kind: PayoutKind.CLIENT_REFUND,
            recipientId: CLIENT_ID,
            msisdn: REGISTERED_MSISDN,
            registeredMsisdn: REGISTERED_MSISDN,
            msisdnOverridden: false,
          },
        },
        prisma,
      );
    });

    it('keeps the manual transfer next to the ones the provider makes', async () => {
      setupExecutable();

      await service.execute(ADMIN_ID, PAYOUT_ID, dto);

      expect(prisma.providerOperation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'manual',
          kind: ProviderOperationKind.PAYOUT,
          providerReference: 'QGH7RT51XK',
          payoutId: PAYOUT_ID,
          paymentId: PAYMENT_ID,
          msisdn: REGISTERED_MSISDN,
          status: ProviderOperationStatus.CONFIRMED,
        }) as object,
      });
    });

    it('tells the recipient the money was sent', async () => {
      setupExecutable();

      await service.execute(ADMIN_ID, PAYOUT_ID, dto);

      expect(notifierMock.payoutExecuted).toHaveBeenCalledWith(PAYOUT_ID);
    });

    it('refuses a payout the provider is sending', async () => {
      setupExecutable(makePayout({ status: PayoutStatus.SENDING }));

      await expect(service.execute(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
        'Este payout está a ser enviado pelo fornecedor.',
      );
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });

    it('refuses an admin paying themselves', async () => {
      setupExecutable(makePayout({ recipientId: ADMIN_ID }));

      await expect(
        service.execute(ADMIN_ID, PAYOUT_ID, dto),
      ).rejects.toMatchObject({
        status: 403,
        response: { errorCode: ErrorCode.MONEY_CONTROL_VIOLATION },
      });
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });

    describe('with four eyes on', () => {
      beforeEach(() => {
        settings.MONEY_FOUR_EYES = 'true';
      });

      it('refuses the admin who confirmed the money coming in', async () => {
        setupExecutable(
          makePayout({
            payment: { ...makePayout().payment, heldById: ADMIN_ID },
          }),
        );

        await expect(
          service.execute(ADMIN_ID, PAYOUT_ID, dto),
        ).rejects.toMatchObject({
          status: 403,
          response: { errorCode: ErrorCode.MONEY_CONTROL_VIOLATION },
        });
        expect(prisma.payout.update).not.toHaveBeenCalled();
      });

      it('lets another admin execute it', async () => {
        setupExecutable();

        const result = await service.execute(ADMIN_ID, PAYOUT_ID, dto);

        expect(result.data.status).toBe(PayoutStatus.EXECUTED);
      });
    });

    it('leaves a trail when the admin sends the money to another number', async () => {
      setupExecutable();
      prisma.payout.update.mockResolvedValue(
        makePayout({
          status: PayoutStatus.EXECUTED,
          mpesaReference: 'QGH7RT51XK',
          msisdn: OTHER_MSISDN,
        }),
      );

      await service.execute(ADMIN_ID, PAYOUT_ID, {
        ...dto,
        msisdn: OTHER_MSISDN,
      });

      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msisdn: OTHER_MSISDN }) as object,
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            msisdn: OTHER_MSISDN,
            registeredMsisdn: REGISTERED_MSISDN,
            msisdnOverridden: true,
          }) as object,
        }),
        prisma,
      );
    });

    it('needs a number when the recipient has none', async () => {
      setupExecutable(makePayout({ msisdn: null }));

      await expect(service.execute(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });

    it.each([PayoutStatus.EXECUTED, PayoutStatus.FAILED])(
      'refuses a payout that is %s, re-read inside the transaction',
      async (status) => {
        setupExecutable(makePayout({ status }));

        await expect(service.execute(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.payout.update).not.toHaveBeenCalled();
        expect(auditMock.record).not.toHaveBeenCalled();
      },
    );

    it('answers 404 for a payout that does not exist', async () => {
      prisma.payout.findUnique.mockResolvedValue(null);

      await expect(service.execute(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses anyone who is not an admin, before touching the payout', async () => {
      await expect(service.execute(CLIENT_ID, PAYOUT_ID, dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('a reference already used by another payout', () => {
      const expectReferenceRefused = async () => {
        const attempt = service.execute(ADMIN_ID, PAYOUT_ID, dto);

        await expect(attempt).rejects.toThrow(ApiException);
        await expect(attempt).rejects.toMatchObject({
          status: 409,
          response: { errorCode: ErrorCode.PAYOUT_REFERENCE_ALREADY_USED },
        });
        expect(auditMock.record).not.toHaveBeenCalled();
      };

      it('is refused with 409 by the check inside the transaction', async () => {
        setupExecutable();
        prisma.payout.findFirst.mockResolvedValue({ id: 'payout-uuid-002' });

        await expectReferenceRefused();
        expect(prisma.payout.update).not.toHaveBeenCalled();
      });

      it('is refused with the same 409 when the unique index catches it', async () => {
        setupExecutable();
        prisma.payout.update.mockRejectedValue(uniqueViolation());

        await expectReferenceRefused();
      });

      it('is refused with the same 409 when the reference already closes an incoming payment', async () => {
        setupExecutable();
        prisma.providerOperation.create.mockRejectedValue(uniqueViolation());

        await expectReferenceRefused();
      });
    });

    it('answers 409 when another request touches the payout at the same time', async () => {
      setupExecutable();
      prisma.$transaction.mockRejectedValue(serializationFailure());

      const attempt = service.execute(ADMIN_ID, PAYOUT_ID, dto);

      await expect(attempt).rejects.toMatchObject({
        status: 409,
        response: { errorCode: ErrorCode.CONFLICT },
      });
      expect(auditMock.record).not.toHaveBeenCalled();
    });
  });

  describe('fail', () => {
    const dto = { reason: '  Número sem conta M-Pesa.  ' };

    it('marks a pending payout as failed, with the reason', async () => {
      prisma.payout.findUnique.mockResolvedValue(makePayout());
      prisma.payout.update.mockResolvedValue(
        makePayout({
          status: PayoutStatus.FAILED,
          failReason: 'Número sem conta M-Pesa.',
        }),
      );

      const result = await service.fail(ADMIN_ID, PAYOUT_ID, dto);

      expect(result.data.status).toBe(PayoutStatus.FAILED);
      expect(prisma.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: PayoutStatus.FAILED,
            failReason: 'Número sem conta M-Pesa.',
          },
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYOUT_FAILED,
          actorId: ADMIN_ID,
          metadata: { reason: 'Número sem conta M-Pesa.' },
        }),
        prisma,
      );
      expect(notifierMock.payoutFailed).toHaveBeenCalledWith(PAYOUT_ID);
    });

    it('refuses a payout the provider is sending', async () => {
      prisma.payout.findUnique.mockResolvedValue(
        makePayout({ status: PayoutStatus.SENDING }),
      );

      await expect(service.fail(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
        'Este payout está a ser enviado pelo fornecedor.',
      );
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });

    it('refuses a payout that was already executed', async () => {
      prisma.payout.findUnique.mockResolvedValue(
        makePayout({ status: PayoutStatus.EXECUTED }),
      );

      await expect(service.fail(ADMIN_ID, PAYOUT_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });

    it('refuses anyone who is not an admin', async () => {
      await expect(service.fail(CLIENT_ID, PAYOUT_ID, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('answers 409 when another request touches the payout at the same time', async () => {
      prisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(
        service.fail(ADMIN_ID, PAYOUT_ID, dto),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('retry', () => {
    const OLD_NUMBER = '+258840000111';
    const NEW_NUMBER = '+258840000222';

    const retriedData = () =>
      (
        prisma.payout.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;

    it('puts a failed payout back in the queue, to the number the account has now', async () => {
      prisma.payout.findUnique.mockResolvedValue(
        makePayout({
          status: PayoutStatus.FAILED,
          kind: PayoutKind.PROVIDER_PAYOUT,
          msisdn: OLD_NUMBER,
        }),
      );
      // A primeira leitura é a do admin; a segunda, a da conta que recebe.
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: ADMIN_ID, role: UserRole.ADMIN })
        .mockResolvedValueOnce({
          payoutMsisdn: NEW_NUMBER,
          phone: OLD_NUMBER,
        });
      prisma.payout.update.mockResolvedValue(makePayout());

      const result = await service.retry(ADMIN_ID, PAYOUT_ID);

      expect(result.data.status).toBe(PayoutStatus.PENDING);
      expect(retriedData()).toEqual({
        status: PayoutStatus.PENDING,
        failReason: null,
        msisdn: NEW_NUMBER,
        // A aprovação valia para o envio que falhou.
        approvedById: null,
        approvedAt: null,
      });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYOUT_RETRIED,
          metadata: expect.objectContaining({
            previousMsisdn: OLD_NUMBER,
          }) as object,
        }),
        prisma,
      );
    });

    it('keeps sending a refund to the number that paid', async () => {
      prisma.payout.findUnique.mockResolvedValue(
        makePayout({
          status: PayoutStatus.FAILED,
          kind: PayoutKind.CLIENT_REFUND,
          msisdn: OLD_NUMBER,
        }),
      );
      // A primeira leitura é a do admin; a segunda, a da conta que recebe.
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: ADMIN_ID, role: UserRole.ADMIN })
        .mockResolvedValueOnce({
          payoutMsisdn: NEW_NUMBER,
          phone: NEW_NUMBER,
        });
      prisma.payment.findUnique.mockResolvedValue({ payerMsisdn: OLD_NUMBER });
      prisma.payout.update.mockResolvedValue(makePayout());

      await service.retry(ADMIN_ID, PAYOUT_ID);

      expect(retriedData().msisdn).toBe(OLD_NUMBER);
    });

    it.each([PayoutStatus.PENDING, PayoutStatus.EXECUTED])(
      'refuses a payout that is %s',
      async (status) => {
        prisma.payout.findUnique.mockResolvedValue(makePayout({ status }));

        await expect(service.retry(ADMIN_ID, PAYOUT_ID)).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.payout.update).not.toHaveBeenCalled();
      },
    );

    it('answers 404 for a payout that does not exist', async () => {
      prisma.payout.findUnique.mockResolvedValue(null);

      await expect(service.retry(ADMIN_ID, PAYOUT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listings', () => {
    beforeEach(() => {
      prisma.payout.findMany.mockResolvedValue([makePayout()]);
      prisma.payout.count.mockResolvedValue(11);
    });

    it('shows the admin the whole queue, oldest first', async () => {
      const result = await service.findAll(ADMIN_ID, {
        page: 2,
        limit: 5,
        status: PayoutStatus.PENDING,
      });

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PayoutStatus.PENDING },
          skip: 5,
          take: 5,
          orderBy: { createdAt: 'asc' },
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

    it('tells the admin which payouts wait for approval', async () => {
      settings.PAYOUT_AUTO_MAX_AMOUNT = '5000';
      prisma.payout.findMany.mockResolvedValue([
        makePayout({ amount: new Prisma.Decimal(5500) }),
        makePayout({ id: 'payout-uuid-002', amount: new Prisma.Decimal(800) }),
      ]);

      const result = await service.findAll(ADMIN_ID, {});

      expect(result.data.map((item) => item.needsApproval)).toEqual([
        true,
        false,
      ]);
    });

    it('closes the whole queue to anyone who is not an admin', async () => {
      await expect(service.findAll(CLIENT_ID, {})).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.payout.findMany).not.toHaveBeenCalled();
    });

    it('shows each person only the payouts addressed to them, newest first', async () => {
      await service.findMine(CLIENT_ID, {});

      expect(prisma.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { recipientId: CLIENT_ID },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });
});
