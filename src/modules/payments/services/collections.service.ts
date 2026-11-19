import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { roundMoney } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { OPEN_DISPUTE_SELECT } from '../../../shared/disputes/open-disputes';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import {
  callProvider,
  newProviderReference,
  PAYMENT_PROVIDER,
  ProviderOutcome,
} from '../providers/payment-provider';
import type { PaymentProvider } from '../providers/payment-provider';
import { toProviderResponse } from '../providers/provider-response';
import { CollectionPresenter } from '../presenters/collection.presenter';
import { LedgerService } from './ledger.service';
import { PaymentNotifier } from './payment-notifier.service';
import { UnallocatedFundsService } from './unallocated-funds.service';

/** Dinheiro que o fornecedor, ou um admin pelo extracto, diz que entrou. */
export interface ConfirmedMoney {
  paymentId: string;
  provider: string;
  providerReference: string;
  receivedAmount: number;
  payerMsisdn: string | null;
  /** Quem dá o dinheiro como entrado: um admin, ou 'system'. */
  actorId: string;
  /**
   * `person`: alguém pediu (um admin, ou o simulador em desenvolvimento), e
   * um problema volta para ele como erro. `provider`: o dinheiro já está na
   * conta e não se pode recusar, por isso o que não fechar o pagamento fica
   * por atribuir, para devolver.
   */
  source: 'person' | 'provider';
  metadata?: Record<string, unknown>;
}

export type ConfirmationResult =
  | { held: true; excess: number }
  | { held: false; reason: UnallocatedReason }
  /** A transacção já estava contada: nada mudou. */
  | { held: false; duplicate: true };

/** O que o cliente precisa de saber para pagar. */
export interface PaymentInstructions {
  mode: 'automatic' | 'manual';
  provider: string;
  receiver: { number: string | null; name: string | null } | null;
}

function paymentConflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste pagamento ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

function referenceAlreadyUsed() {
  return ApiErrors.conflict(
    ErrorCode.PAYMENT_REFERENCE_ALREADY_USED,
    'Esta referência M-Pesa já está registada noutro pagamento ou como dinheiro por atribuir.',
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * A entrada do dinheiro no escrow. É o único caminho: o mark-held do admin,
 * a confirmação do fornecedor e o simulador passam todos por aqui. Também
 * cobra no telemóvel do cliente quando o fornecedor o faz.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly notifier: PaymentNotifier,
    private readonly metrics: MetricsService,
    private readonly unallocated: UnallocatedFundsService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Como pagar: no telemóvel (automático) ou para o número da plataforma. */
  instructions(): PaymentInstructions {
    if (this.provider.collects) {
      return {
        mode: 'automatic',
        provider: this.provider.name,
        receiver: null,
      };
    }

    return {
      mode: 'manual',
      provider: this.provider.name,
      receiver: {
        number:
          this.config.get<string>('PAYMENTS_MANUAL_RECEIVER_NUMBER') ?? null,
        name: this.config.get<string>('PAYMENTS_MANUAL_RECEIVER_NAME') ?? null,
      },
    };
  }

  /**
   * O admin dá o pagamento como recebido, com o que leu no extracto. Fica
   * também uma operação manual, para todos os movimentos estarem na mesma
   * tabela.
   */
  async confirmByAdmin(
    adminId: string,
    paymentId: string,
    receipt: {
      mpesaReference: string;
      receivedAmount: number;
      payerMsisdn: string;
    },
  ) {
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          const result = await this.applyConfirmedMoney(tx, {
            paymentId,
            provider: 'manual',
            providerReference: receipt.mpesaReference,
            receivedAmount: receipt.receivedAmount,
            payerMsisdn: receipt.payerMsisdn,
            actorId: adminId,
            source: 'person',
          });

          await tx.providerOperation.create({
            data: {
              provider: 'manual',
              kind: ProviderOperationKind.COLLECTION,
              reference: newProviderReference('MANUAL'),
              providerReference: receipt.mpesaReference,
              paymentId,
              amount: roundMoney(receipt.receivedAmount),
              msisdn: receipt.payerMsisdn,
              status: ProviderOperationStatus.CONFIRMED,
              confirmedAt: new Date(),
            },
          });

          return result;
        },
        paymentConflict,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw referenceAlreadyUsed();
      }
      throw error;
    }
  }

  /** O simulador de desenvolvimento dá o pagamento como recebido. */
  async confirmSimulated(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { totalCharged: true },
    });
    const providerReference = `MOCK${newProviderReference('COLLECTION').slice(2)}`;

    return runSerializable(
      this.prisma,
      async (tx) => {
        const result = await this.applyConfirmedMoney(tx, {
          paymentId,
          provider: 'simulator',
          providerReference,
          receivedAmount: Number(payment.totalCharged),
          payerMsisdn: null,
          actorId: userId,
          source: 'person',
          metadata: { mock: true },
        });

        await tx.providerOperation.create({
          data: {
            provider: 'simulator',
            kind: ProviderOperationKind.COLLECTION,
            reference: newProviderReference('COLLECTION'),
            providerReference,
            paymentId,
            amount: payment.totalCharged,
            status: ProviderOperationStatus.CONFIRMED,
            confirmedAt: new Date(),
          },
        });

        return result;
      },
      paymentConflict,
    );
  }

  /**
   * O cliente pede a cobrança no telemóvel dele. Só há uma cobrança em curso
   * por pagamento, e uma cobrança cujo resultado se desconhece nunca se
   * repete: o job pergunta ao fornecedor.
   */
  async request(userId: string, paymentId: string, msisdn: string) {
    if (!this.provider.collects) {
      throw ApiErrors.badRequest(
        ErrorCode.PAYMENT_COLLECTION_UNAVAILABLE,
        'A cobrança no telemóvel ainda não está ligada. Paga para o número indicado nas instruções e declara a referência.',
      );
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        clientId: true,
        status: true,
        totalCharged: true,
        receiptNumber: true,
        booking: { select: { status: true } },
        serviceBooking: { select: { status: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    if (payment.clientId !== userId) {
      throw new ForbiddenException(
        'Só o cliente da reserva pode pagar este pagamento.',
      );
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException('Este pagamento já não está por pagar.');
    }

    if (!this.reservationAwaitsPayment(payment)) {
      throw new BadRequestException(
        'A reserva deste pagamento já não está à espera de pagamento.',
      );
    }

    let operation;
    try {
      operation = await this.prisma.providerOperation.create({
        data: {
          provider: this.provider.name,
          kind: ProviderOperationKind.COLLECTION,
          reference: newProviderReference('COLLECTION'),
          paymentId,
          amount: payment.totalCharged,
          msisdn,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiErrors.conflict(
          ErrorCode.PAYMENT_COLLECTION_IN_PROGRESS,
          'Já há uma cobrança em curso para este pagamento. Confirma no telemóvel ou espera pelo resultado.',
        );
      }
      throw error;
    }

    await this.audit.record({
      action: AuditAction.PAYMENT_COLLECTION_REQUESTED,
      actorId: userId,
      targetType: 'Payment',
      targetId: paymentId,
      amount: payment.totalCharged,
      metadata: {
        provider: this.provider.name,
        reference: operation.reference,
        msisdn,
      },
    });

    const outcome = await callProvider(() =>
      this.provider.requestCollection({
        reference: operation.reference,
        amount: Number(payment.totalCharged),
        msisdn,
        description: `ZUNO ${payment.receiptNumber}`,
      }),
    );
    await this.settle(operation.id, outcome);

    return {
      message: 'Pedido de pagamento enviado. Confirma no telemóvel.',
      data: await this.latestCollection(paymentId),
    };
  }

  /**
   * Aplica o que o fornecedor disse de uma cobrança. Repetir não faz nada.
   * Uma confirmação nunca se perde: mesmo para uma cobrança dada como
   * falhada, o dinheiro entra no pagamento ou fica por atribuir.
   */
  async settle(operationId: string, outcome: ProviderOutcome): Promise<void> {
    const result = await runSerializable(
      this.prisma,
      async (tx) => {
        const operation = await tx.providerOperation.findUnique({
          where: { id: operationId },
        });

        if (
          !operation ||
          operation.kind !== ProviderOperationKind.COLLECTION ||
          operation.status === ProviderOperationStatus.CONFIRMED
        ) {
          return null;
        }

        // Depois de falhada, só uma confirmação conta: o dinheiro chegou.
        if (
          operation.status === ProviderOperationStatus.FAILED &&
          outcome.status !== 'CONFIRMED'
        ) {
          return null;
        }

        if (outcome.status === 'CONFIRMED') {
          await tx.providerOperation.update({
            where: { id: operationId },
            data: {
              status: ProviderOperationStatus.CONFIRMED,
              providerReference: outcome.providerReference,
              feeAmount: outcome.fee ?? null,
              confirmedAt: new Date(),
              response: toProviderResponse(outcome),
            },
          });

          const confirmation = await this.applyConfirmedMoney(tx, {
            paymentId: operation.paymentId as string,
            provider: operation.provider,
            providerReference: outcome.providerReference,
            receivedAmount: outcome.amount,
            payerMsisdn: outcome.msisdn ?? operation.msisdn,
            actorId: SYSTEM_ACTOR_ID,
            source: 'provider',
            metadata: { reference: operation.reference },
          });

          return { paymentId: operation.paymentId as string, confirmation };
        }

        if (outcome.status === 'FAILED') {
          await tx.providerOperation.update({
            where: { id: operationId },
            data: {
              status: ProviderOperationStatus.FAILED,
              failureCode: outcome.code,
              failureReason: outcome.reason,
              response: toProviderResponse(outcome),
            },
          });

          await this.audit.record(
            {
              action: AuditAction.PAYMENT_COLLECTION_FAILED,
              actorId: SYSTEM_ACTOR_ID,
              targetType: 'Payment',
              targetId: operation.paymentId as string,
              amount: operation.amount,
              metadata: {
                reference: operation.reference,
                code: outcome.code,
                reason: outcome.reason,
              },
            },
            tx,
          );

          return {
            paymentId: operation.paymentId as string,
            failure: outcome.reason,
          };
        }

        await tx.providerOperation.update({
          where: { id: operationId },
          data: {
            status:
              outcome.status === 'PENDING'
                ? ProviderOperationStatus.PENDING
                : ProviderOperationStatus.UNKNOWN,
            ...(outcome.status === 'PENDING' && outcome.providerReference
              ? { providerReference: outcome.providerReference }
              : {}),
            response: toProviderResponse(outcome),
          },
        });

        return null;
      },
      paymentConflict,
    );

    if (result?.confirmation?.held) {
      this.metrics.businessEvents.inc({ event: 'payment_collected' });
      void this.notifier.held(result.paymentId);
    }

    if (result?.failure) {
      void this.notifier.collectionFailed(result.paymentId, result.failure);
    }
  }

  /** A cobrança mais recente do pagamento, como a app a mostra. */
  async latestCollection(paymentId: string) {
    const operation = await this.prisma.providerOperation.findFirst({
      where: { paymentId, kind: ProviderOperationKind.COLLECTION },
      orderBy: { createdAt: 'desc' },
    });

    return operation ? CollectionPresenter.toItem(operation) : null;
  }

  /**
   * Põe o dinheiro no escrow dentro da transacção do chamador.
   *
   * - O valor certo: o pagamento fica HELD.
   * - A mais: fica HELD com o total, e a diferença fica por atribuir.
   * - A menos, ou para um pagamento que já não espera dinheiro: um admin
   *   recebe o erro. Do fornecedor, o dinheiro já está na conta e fica todo
   *   por atribuir, para devolver.
   * - Uma transacção que já fecha um pagamento ou já está por atribuir conta
   *   uma vez só: o admin recebe 409, e o fornecedor que a repete não muda
   *   nada (o admin pode tê-la confirmado pelo extracto antes do aviso).
   */
  async applyConfirmedMoney(
    tx: Prisma.TransactionClient,
    money: ConfirmedMoney,
  ): Promise<ConfirmationResult> {
    const payment = await tx.payment.findUnique({
      where: { id: money.paymentId },
      select: {
        id: true,
        status: true,
        totalCharged: true,
        depositAmount: true,
        bookingId: true,
        serviceBookingId: true,
        declaredReference: true,
        booking: { select: { status: true } },
        serviceBooking: { select: { status: true } },
        disputes: OPEN_DISPUTE_SELECT,
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    if (
      money.source === 'provider' &&
      (await this.unallocated.isAccounted(tx, money.providerReference))
    ) {
      return { held: false, duplicate: true };
    }

    const expected = roundMoney(Number(payment.totalCharged));
    const received = roundMoney(money.receivedAmount);
    const setAside = (reason: UnallocatedReason, amount: number) =>
      this.unallocated.record(tx, {
        provider: money.provider,
        providerReference: money.providerReference,
        amount,
        payerMsisdn: money.payerMsisdn,
        paymentId: payment.id,
        reason,
        recordedById: money.actorId,
      });

    const stillWaiting =
      payment.status === PaymentStatus.PENDING &&
      this.reservationAwaitsPayment(payment) &&
      payment.disputes.length === 0;

    if (!stillWaiting) {
      if (money.source === 'person') {
        throw this.notWaitingError(payment);
      }
      await setAside(UnallocatedReason.LATE, received);
      return { held: false, reason: UnallocatedReason.LATE };
    }

    if (received < expected) {
      if (money.source === 'person') {
        throw ApiErrors.badRequest(
          ErrorCode.PAYMENT_AMOUNT_MISMATCH,
          `O valor recebido (${received} MZN) é menor do que o total do pagamento (${expected} MZN). Não entra no escrow: regista-o como dinheiro por atribuir, para ser devolvido.`,
        );
      }
      await setAside(UnallocatedReason.AMOUNT_MISMATCH, received);
      return { held: false, reason: UnallocatedReason.AMOUNT_MISMATCH };
    }

    if (
      money.source === 'person' &&
      (await this.unallocated.isAccounted(tx, money.providerReference))
    ) {
      throw referenceAlreadyUsed();
    }

    await this.holdInEscrow(tx, payment, money, expected);

    const excess = roundMoney(received - expected);
    if (excess > 0) {
      await setAside(UnallocatedReason.OVERPAYMENT, excess);
    }

    await this.audit.record(
      {
        action: AuditAction.PAYMENT_MARKED_HELD,
        actorId: money.actorId,
        targetType: 'Payment',
        targetId: payment.id,
        amount: expected,
        // A referência que o cliente declarou fica ao lado da confirmada,
        // para se ver depois se coincidiam.
        metadata: {
          provider: money.provider,
          mpesaReference: money.providerReference,
          payerMsisdn: money.payerMsisdn,
          declaredReference: payment.declaredReference,
          receivedAmount: received,
          excess,
          ...money.metadata,
        },
      },
      tx,
    );

    return { held: true, excess };
  }

  private async holdInEscrow(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      depositAmount: Prisma.Decimal;
      bookingId: string | null;
      serviceBookingId: string | null;
    },
    money: ConfirmedMoney,
    expected: number,
  ) {
    // Com o dinheiro no escrow, a reserva deixa de ter prazo de pagamento.
    if (payment.bookingId) {
      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { expiresAt: null },
      });
    }
    if (payment.serviceBookingId) {
      await tx.serviceBooking.update({
        where: { id: payment.serviceBookingId },
        data: { expiresAt: null },
      });
    }

    const bySystem = money.actorId === SYSTEM_ACTOR_ID;

    await this.ledger.record(tx, {
      paymentId: payment.id,
      direction: LedgerDirection.INFLOW,
      party: LedgerParty.CLIENT,
      amount: expected,
      reason: bySystem
        ? 'Pagamento confirmado pelo fornecedor e retido no escrow.'
        : 'Pagamento confirmado e retido no escrow.',
      actorId: bySystem ? null : money.actorId,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.HELD,
        heldAt: new Date(),
        heldById: money.actorId,
        mpesaReference: money.providerReference,
        payerMsisdn: money.payerMsisdn,
        receivedAmount: expected,
        depositStatus:
          Number(payment.depositAmount) > 0
            ? DepositStatus.HELD
            : DepositStatus.NONE,
      },
    });
  }

  /** O dinheiro só entra para uma reserva que ainda o espera. */
  private reservationAwaitsPayment(payment: {
    booking: { status: BookingStatus } | null;
    serviceBooking: { status: ServiceBookingStatus } | null;
  }): boolean {
    return payment.booking
      ? payment.booking.status === BookingStatus.CONFIRMED
      : payment.serviceBooking?.status === ServiceBookingStatus.PENDING;
  }

  private notWaitingError(payment: {
    status: PaymentStatus;
    disputes: unknown[];
  }) {
    if (payment.status !== PaymentStatus.PENDING) {
      return new BadRequestException(
        'Apenas pagamentos pendentes podem ser marcados como retidos.',
      );
    }
    if (payment.disputes.length > 0) {
      return new BadRequestException(
        'Não é possível reter pagamento com disputa associada.',
      );
    }
    return new BadRequestException(
      'A reserva deste pagamento já não está à espera de pagamento.',
    );
  }
}
