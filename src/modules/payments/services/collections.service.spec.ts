import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  BookingStatus,
  DepositStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  Prisma,
  ProviderOperationKind,
  ProviderOperationStatus,
  ServiceBookingStatus,
  UnallocatedReason,
} from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { ManualPaymentProvider } from '../providers/manual.provider';
import { CollectionsService, ConfirmedMoney } from './collections.service';
import { LedgerService } from './ledger.service';
import { PaymentNotifier } from './payment-notifier.service';
import { UnallocatedFundsService } from './unallocated-funds.service';

const ADMIN_ID = 'admin-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const SERVICE_BOOKING_ID = 'service-booking-uuid-001';
const OPERATION_ID = 'operation-uuid-001';

// O que o admin lê no extracto M-Pesa. O valor é o total do pagamento.
const RECEIPT = {
  mpesaReference: 'CHK7H3ABCD',
  receivedAmount: 2700,
  payerMsisdn: '+258840000002',
};

const auditMock = { record: jest.fn() };
const ledgerMock = { record: jest.fn() };
const notifierMock = { held: jest.fn(), collectionFailed: jest.fn() };
const metricsMock = { businessEvents: { inc: jest.fn() } };
const unallocatedMock = { record: jest.fn(), isAccounted: jest.fn() };
const configMock = { get: jest.fn() };

/** O pagamento como o caminho das cobranças o relê dentro da transacção. */
const pendingPayment = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  status: PaymentStatus.PENDING,
  totalCharged: new Prisma.Decimal(2700),
  depositAmount: new Prisma.Decimal(500),
  bookingId: BOOKING_ID,
  serviceBookingId: null,
  declaredReference: 'CHK7H3ABCD',
  booking: { status: BookingStatus.CONFIRMED },
  serviceBooking: null,
  disputes: [],
  ...overrides,
});

const pendingServicePayment = (overrides: Record<string, unknown> = {}) =>
  pendingPayment({
    depositAmount: new Prisma.Decimal(0),
    bookingId: null,
    serviceBookingId: SERVICE_BOOKING_ID,
    booking: null,
    serviceBooking: { status: ServiceBookingStatus.PENDING },
    ...overrides,
  });

const makePrisma = () => ({
  payment: { findUnique: jest.fn(), update: jest.fn() },
  booking: { update: jest.fn() },
  serviceBooking: { update: jest.fn() },
  providerOperation: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
});

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(code, {
    code,
    clientVersion: 'teste',
  });

describe('CollectionsService', () => {
  let service: CollectionsService;
  let prisma: ReturnType<typeof makePrisma>;
  const tx = () => prisma as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma = makePrisma();
    prisma.$transaction.mockImplementation(
      (work: (client: typeof prisma) => Promise<unknown>) => work(prisma),
    );
    unallocatedMock.isAccounted.mockResolvedValue(false);

    service = new CollectionsService(
      prisma as unknown as PrismaService,
      auditMock as unknown as AuditService,
      ledgerMock as unknown as LedgerService,
      notifierMock as unknown as PaymentNotifier,
      metricsMock as unknown as MetricsService,
      unallocatedMock as unknown as UnallocatedFundsService,
      configMock as unknown as ConfigService,
      new ManualPaymentProvider(),
    );
  });

  /** O admin confirma com o que leu no extracto; o erro, se houver. */
  const confirmError = async (
    receipt = RECEIPT,
  ): Promise<ApiException & BadRequestException> => {
    try {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, receipt);
    } catch (error) {
      return error as ApiException & BadRequestException;
    }
    throw new Error('A confirmação devia ter sido recusada.');
  };

  const expectNothingMoved = () => {
    expect(ledgerMock.record).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.providerOperation.create).not.toHaveBeenCalled();
  };

  describe('confirmByAdmin(): o valor certo', () => {
    beforeEach(() => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
    });

    it('põe o pagamento HELD com a referência, o número pagador e quem confirmou', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID },
        data: {
          status: PaymentStatus.HELD,
          heldAt: expect.any(Date) as Date,
          heldById: ADMIN_ID,
          mpesaReference: RECEIPT.mpesaReference,
          payerMsisdn: RECEIPT.payerMsisdn,
          receivedAmount: 2700,
          depositStatus: DepositStatus.HELD,
        },
      });
    });

    // CRÍTICO: todo movimento de dinheiro escreve LedgerEntry na mesma transacção.
    it('regista o INFLOW do total no ledger, dentro da transacção', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(ledgerMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.INFLOW,
          party: LedgerParty.CLIENT,
          amount: 2700,
          actorId: ADMIN_ID,
        }),
      );
    });

    it('marca o depósito NONE quando o pagamento não tem depósito', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ depositAmount: new Prisma.Decimal(0) }),
      );

      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depositStatus: DepositStatus.NONE,
          }) as object,
        }),
      );
    });

    it('tira o prazo de pagamento à reserva', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { expiresAt: null },
      });
      expect(prisma.serviceBooking.update).not.toHaveBeenCalled();
    });

    it('tira o prazo de pagamento à reserva de serviço', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingServicePayment());

      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(prisma.serviceBooking.update).toHaveBeenCalledWith({
        where: { id: SERVICE_BOOKING_ID },
        data: { expiresAt: null },
      });
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('guarda a confirmação como operação manual, ao lado das do fornecedor', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(prisma.providerOperation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'manual',
          kind: ProviderOperationKind.COLLECTION,
          providerReference: RECEIPT.mpesaReference,
          paymentId: PAYMENT_ID,
          amount: 2700,
          msisdn: RECEIPT.payerMsisdn,
          status: ProviderOperationStatus.CONFIRMED,
        }) as object,
      });
    });

    it('deixa em auditoria, na mesma transacção, a referência confirmada ao lado da declarada', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_MARKED_HELD,
          actorId: ADMIN_ID,
          targetId: PAYMENT_ID,
          amount: 2700,
          metadata: {
            provider: 'manual',
            mpesaReference: RECEIPT.mpesaReference,
            payerMsisdn: RECEIPT.payerMsisdn,
            declaredReference: 'CHK7H3ABCD',
            receivedAmount: 2700,
            excess: 0,
          },
        }),
        prisma,
      );
    });

    it('não regista nada por atribuir', async () => {
      await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT);

      expect(unallocatedMock.record).not.toHaveBeenCalled();
    });
  });

  describe('confirmByAdmin(): o valor errado', () => {
    beforeEach(() => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
    });

    it.each([2699.99, 100])(
      'recusa %p MZN, menos do que o total de 2700, sem mexer em nada',
      async (receivedAmount) => {
        const error = await confirmError({ ...RECEIPT, receivedAmount });

        expect(error.getStatus()).toBe(400);
        expect(error.errorCode).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
        expectNothingMoved();
        expect(unallocatedMock.record).not.toHaveBeenCalled();
      },
    );

    it.each([
      [2700.01, 0.01],
      [5000, 2300],
    ])(
      'com %p MZN, retém o total e deixa %p por atribuir',
      async (receivedAmount, excess) => {
        await service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, {
          ...RECEIPT,
          receivedAmount,
        });

        expect(ledgerMock.record).toHaveBeenCalledWith(
          prisma,
          expect.objectContaining({ amount: 2700 }),
        );
        expect(unallocatedMock.record).toHaveBeenCalledWith(prisma, {
          provider: 'manual',
          providerReference: RECEIPT.mpesaReference,
          amount: excess,
          payerMsisdn: RECEIPT.payerMsisdn,
          paymentId: PAYMENT_ID,
          reason: UnallocatedReason.OVERPAYMENT,
          recordedById: ADMIN_ID,
        });
      },
    );

    it('compara com o total relido dentro da transacção', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ totalCharged: new Prisma.Decimal(3100) }),
      );

      const error = await confirmError();

      expect(error.errorCode).toBe(ErrorCode.PAYMENT_AMOUNT_MISMATCH);
    });
  });

  describe('confirmByAdmin(): um pagamento que já não espera dinheiro', () => {
    it('recusa um pagamento que já não está PENDING', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ status: PaymentStatus.HELD }),
      );

      const error = await confirmError();

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(
        'Apenas pagamentos pendentes podem ser marcados como retidos.',
      );
      expectNothingMoved();
    });

    it('recusa um pagamento com disputa aberta', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ disputes: [{ id: 'dispute-1' }] }),
      );

      const error = await confirmError();

      expect(error.message).toBe(
        'Não é possível reter pagamento com disputa associada.',
      );
      expectNothingMoved();
    });

    it.each([
      [
        'um aluguer que expirou',
        { booking: { status: BookingStatus.EXPIRED } },
      ],
      [
        'um aluguer cancelado entretanto',
        { booking: { status: BookingStatus.CANCELLED } },
      ],
      [
        'um serviço cancelado entretanto',
        {
          booking: null,
          serviceBooking: { status: ServiceBookingStatus.CANCELLED },
        },
      ],
      [
        'um serviço que expirou',
        {
          booking: null,
          serviceBooking: { status: ServiceBookingStatus.EXPIRED },
        },
      ],
    ])('recusa o dinheiro para %s', async (_label, reservation) => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment(reservation));

      const error = await confirmError();

      expect(error.message).toBe(
        'A reserva deste pagamento já não está à espera de pagamento.',
      );
      expectNothingMoved();
    });

    it('responde 404 a um pagamento que não existe', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmByAdmin(ADMIN_ID, PAYMENT_ID, RECEIPT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmByAdmin(): a referência conta uma vez só', () => {
    beforeEach(() => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
    });

    it('recusa com 409 uma referência que já fecha um pagamento ou está por atribuir', async () => {
      unallocatedMock.isAccounted.mockResolvedValue(true);

      const error = await confirmError();

      expect(error.getStatus()).toBe(409);
      expect(error.errorCode).toBe(ErrorCode.PAYMENT_REFERENCE_ALREADY_USED);
      expect(unallocatedMock.isAccounted).toHaveBeenCalledWith(
        prisma,
        RECEIPT.mpesaReference,
      );
      expectNothingMoved();
    });

    it('responde o mesmo 409 quando é um índice único a apanhar a referência', async () => {
      prisma.$transaction.mockRejectedValue(knownError('P2002'));

      const error = await confirmError();

      expect(error.getStatus()).toBe(409);
      expect(error.errorCode).toBe(ErrorCode.PAYMENT_REFERENCE_ALREADY_USED);
    });

    it('responde 409 CONFLICT quando outro pedido mexe no pagamento ao mesmo tempo', async () => {
      prisma.$transaction.mockRejectedValue(knownError('P2034'));

      const error = await confirmError();

      expect(error.getStatus()).toBe(409);
      expect(error.errorCode).toBe(ErrorCode.CONFLICT);
    });
  });

  describe('applyConfirmedMoney(): o dinheiro que o fornecedor confirma', () => {
    const fromProvider = (
      overrides: Partial<ConfirmedMoney> = {},
    ): ConfirmedMoney => ({
      paymentId: PAYMENT_ID,
      provider: 'mpesa',
      providerReference: 'MP0000000001',
      receivedAmount: 2700,
      payerMsisdn: '+258840000002',
      actorId: SYSTEM_ACTOR_ID,
      source: 'provider',
      ...overrides,
    });

    it('com o valor certo, retém com o ledger sem actor humano', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());

      const result = await service.applyConfirmedMoney(tx(), fromProvider());

      expect(result).toEqual({ held: true, excess: 0 });
      expect(ledgerMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          amount: 2700,
          actorId: null,
          reason: 'Pagamento confirmado pelo fornecedor e retido no escrow.',
        }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            heldById: SYSTEM_ACTOR_ID,
          }) as object,
        }),
      );
    });

    it('com valor a menos, não recusa: o dinheiro todo fica por atribuir', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());

      const result = await service.applyConfirmedMoney(
        tx(),
        fromProvider({ receivedAmount: 2000 }),
      );

      expect(result).toEqual({
        held: false,
        reason: UnallocatedReason.AMOUNT_MISMATCH,
      });
      expect(unallocatedMock.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          amount: 2000,
          reason: UnallocatedReason.AMOUNT_MISMATCH,
          paymentId: PAYMENT_ID,
        }),
      );
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it.each([
      ['um pagamento que já falhou', { status: PaymentStatus.FAILED }],
      ['uma reserva expirada', { booking: { status: BookingStatus.EXPIRED } }],
    ])(
      'para %s, o dinheiro chegou tarde e fica por atribuir',
      async (_label, state) => {
        prisma.payment.findUnique.mockResolvedValue(pendingPayment(state));

        const result = await service.applyConfirmedMoney(tx(), fromProvider());

        expect(result).toEqual({
          held: false,
          reason: UnallocatedReason.LATE,
        });
        expect(unallocatedMock.record).toHaveBeenCalledWith(
          prisma,
          expect.objectContaining({
            amount: 2700,
            reason: UnallocatedReason.LATE,
          }),
        );
        expect(ledgerMock.record).not.toHaveBeenCalled();
      },
    );

    it('uma transacção que o admin já contou pelo extracto não entra outra vez', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ status: PaymentStatus.HELD }),
      );
      unallocatedMock.isAccounted.mockResolvedValue(true);

      const result = await service.applyConfirmedMoney(tx(), fromProvider());

      expect(result).toEqual({ held: false, duplicate: true });
      expect(unallocatedMock.record).not.toHaveBeenCalled();
      expect(ledgerMock.record).not.toHaveBeenCalled();
    });
  });

  describe('settle(): o desfecho de uma cobrança', () => {
    const operation = (overrides: Record<string, unknown> = {}) => ({
      id: OPERATION_ID,
      provider: 'mpesa',
      kind: ProviderOperationKind.COLLECTION,
      reference: 'ZC0123456789ABCD',
      paymentId: PAYMENT_ID,
      amount: new Prisma.Decimal(2700),
      msisdn: '+258840000002',
      status: ProviderOperationStatus.REQUESTED,
      ...overrides,
    });

    it('confirmada: guarda a confirmação, retém e avisa as partes', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(operation());
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());

      await service.settle(OPERATION_ID, {
        status: 'CONFIRMED',
        providerReference: 'MP0000000001',
        amount: 2700,
        fee: 12.5,
      });

      expect(prisma.providerOperation.update).toHaveBeenCalledWith({
        where: { id: OPERATION_ID },
        data: expect.objectContaining({
          status: ProviderOperationStatus.CONFIRMED,
          providerReference: 'MP0000000001',
          feeAmount: 12.5,
        }) as object,
      });
      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
      expect(notifierMock.held).toHaveBeenCalledWith(PAYMENT_ID);
      expect(metricsMock.businessEvents.inc).toHaveBeenCalledWith({
        event: 'payment_collected',
      });
    });

    it('recusada: fica FAILED, em auditoria, e o cliente é avisado', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(operation());

      await service.settle(OPERATION_ID, {
        status: 'FAILED',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'Saldo insuficiente.',
      });

      expect(prisma.providerOperation.update).toHaveBeenCalledWith({
        where: { id: OPERATION_ID },
        data: expect.objectContaining({
          status: ProviderOperationStatus.FAILED,
          failureCode: 'INSUFFICIENT_FUNDS',
        }) as object,
      });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_COLLECTION_FAILED,
        }),
        prisma,
      );
      expect(notifierMock.collectionFailed).toHaveBeenCalledWith(
        PAYMENT_ID,
        'Saldo insuficiente.',
      );
      expect(ledgerMock.record).not.toHaveBeenCalled();
    });

    it('repetir uma confirmação já aplicada não faz nada', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(
        operation({ status: ProviderOperationStatus.CONFIRMED }),
      );

      await service.settle(OPERATION_ID, {
        status: 'CONFIRMED',
        providerReference: 'MP0000000001',
        amount: 2700,
      });

      expect(prisma.providerOperation.update).not.toHaveBeenCalled();
      expect(ledgerMock.record).not.toHaveBeenCalled();
      expect(notifierMock.held).not.toHaveBeenCalled();
    });

    it('depois de falhada, ignora tudo menos uma confirmação', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(
        operation({ status: ProviderOperationStatus.FAILED }),
      );

      await service.settle(OPERATION_ID, { status: 'PENDING' });

      expect(prisma.providerOperation.update).not.toHaveBeenCalled();
    });

    it('depois de falhada, uma confirmação ainda conta: o dinheiro chegou', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(
        operation({ status: ProviderOperationStatus.FAILED }),
      );
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());

      await service.settle(OPERATION_ID, {
        status: 'CONFIRMED',
        providerReference: 'MP0000000001',
        amount: 2700,
      });

      expect(ledgerMock.record).toHaveBeenCalledTimes(1);
    });

    it('sem resposta: fica UNKNOWN, para o job perguntar depois', async () => {
      prisma.providerOperation.findUnique.mockResolvedValue(operation());

      await service.settle(OPERATION_ID, {
        status: 'UNKNOWN',
        reason: 'timeout',
      });

      expect(prisma.providerOperation.update).toHaveBeenCalledWith({
        where: { id: OPERATION_ID },
        data: expect.objectContaining({
          status: ProviderOperationStatus.UNKNOWN,
        }) as object,
      });
      expect(ledgerMock.record).not.toHaveBeenCalled();
    });
  });
});
