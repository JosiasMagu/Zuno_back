import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  UserRole,
} from '@prisma/client';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { SERVICE_PAYMENT_WINDOW_HOURS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { OPEN_DISPUTE_SELECT } from '../../../shared/disputes/open-disputes';
import { paymentDeadline } from '../../bookings/booking-deadlines';
import { assertNotPartyToPayment } from '../money-controls';
import { PaymentPresenter } from '../presenters/payment.presenter';
import { LedgerService } from './ledger.service';
import { PaymentNotifier } from './payment-notifier.service';

const HOUR_MS = 60 * 60 * 1000;

const VOIDABLE_SELECT = {
  id: true,
  status: true,
  heldById: true,
  clientId: true,
  ownerId: true,
  totalCharged: true,
  depositStatus: true,
  mpesaReference: true,
  bookingId: true,
  serviceBookingId: true,
  booking: { select: { status: true, startDate: true } },
  serviceBooking: { select: { status: true } },
  disputes: OPEN_DISPUTE_SELECT,
} satisfies Prisma.PaymentSelect;

type VoidablePayment = Prisma.PaymentGetPayload<{
  select: typeof VOIDABLE_SELECT;
}>;

const PAYMENT_INCLUDE = {
  booking: {
    select: { id: true, startDate: true, endDate: true, status: true },
  },
  serviceBooking: {
    select: { id: true, status: true, scheduledFor: true },
  },
} as const;

function paymentChanged() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste pagamento ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

/**
 * Anula a confirmação de entrada de um pagamento dada por engano: o dinheiro
 * não entrou, ou era de outra reserva. Sem isto, a única saída era
 * reembolsar, o que criava um payout de dinheiro que nunca existiu.
 *
 * O ledger não se apaga: a entrada errada fica e junta-se-lhe um estorno. O
 * pagamento volta a estar por pagar, com prazo novo, e a referência M-Pesa
 * fica livre para o pagamento certo.
 */
@Injectable()
export class HoldVoidService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly notifier: PaymentNotifier,
  ) {}

  async voidHold(adminId: string, paymentId: string, reason: string) {
    await this.assertAdmin(adminId);

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: VOIDABLE_SELECT,
    });
    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }
    this.assertVoidable(payment, adminId);

    await runSerializable(
      this.prisma,
      (tx) => this.applyVoid(tx, adminId, paymentId, reason.trim()),
      paymentChanged,
    );

    void this.notifier.holdVoided(paymentId);

    const updated = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: PAYMENT_INCLUDE,
    });

    return {
      message:
        'Confirmação anulada. O pagamento voltou a estar por pagar e a referência ficou livre.',
      data: PaymentPresenter.toListItem(updated),
    };
  }

  private async applyVoid(
    tx: Prisma.TransactionClient,
    adminId: string,
    paymentId: string,
    reason: string,
  ) {
    // O cliente pode ter confirmado a entrega ou aberto disputa entretanto.
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: VOIDABLE_SELECT,
    });
    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }
    this.assertVoidable(payment, adminId);

    const reference = payment.mpesaReference;
    if (reference) {
      const setAside = await tx.unallocatedFunds.count({
        where: { paymentId, providerReference: reference },
      });
      if (setAside > 0) {
        throw new BadRequestException(
          'Esta confirmação deixou dinheiro em excesso por atribuir. Resolve-o primeiro em dinheiro por atribuir.',
        );
      }
    }

    await this.ledger.record(tx, {
      paymentId,
      direction: LedgerDirection.OUTFLOW,
      party: LedgerParty.REVERSAL,
      amount: Number(payment.totalCharged),
      reason: `Estorno da entrada confirmada por engano: ${reason}`,
      actorId: adminId,
    });

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.PENDING,
        heldAt: null,
        heldById: null,
        mpesaReference: null,
        payerMsisdn: null,
        receivedAmount: null,
        ...(payment.depositStatus === DepositStatus.HELD
          ? { depositStatus: DepositStatus.NONE }
          : {}),
      },
    });

    // A operação da confirmação larga a referência, para o pagamento certo
    // a poder usar.
    if (reference) {
      await tx.providerOperation.updateMany({
        where: {
          paymentId,
          kind: ProviderOperationKind.COLLECTION,
          status: ProviderOperationStatus.CONFIRMED,
          providerReference: reference,
        },
        data: {
          status: ProviderOperationStatus.FAILED,
          providerReference: null,
          failureCode: 'HOLD_VOIDED',
          failureReason: reason,
        },
      });
    }

    await this.reopenPaymentWindow(tx, payment);

    await this.audit.record(
      {
        action: AuditAction.PAYMENT_HOLD_VOIDED,
        actorId: adminId,
        targetType: 'Payment',
        targetId: paymentId,
        amount: payment.totalCharged,
        metadata: {
          reason,
          confirmedBy: payment.heldById,
          mpesaReference: reference,
        },
      },
      tx,
    );
  }

  /** Com a confirmação anulada, a reserva volta a ter prazo para ser paga. */
  private async reopenPaymentWindow(
    tx: Prisma.TransactionClient,
    payment: VoidablePayment,
  ) {
    const now = new Date();

    if (payment.bookingId && payment.booking) {
      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { expiresAt: paymentDeadline(now, payment.booking.startDate) },
      });
    }

    if (payment.serviceBookingId) {
      await tx.serviceBooking.update({
        where: { id: payment.serviceBookingId },
        data: {
          expiresAt: new Date(
            now.getTime() + SERVICE_PAYMENT_WINDOW_HOURS * HOUR_MS,
          ),
        },
      });
    }
  }

  private assertVoidable(payment: VoidablePayment, adminId: string) {
    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'Só se anula a confirmação de um pagamento que ainda está retido.',
      );
    }

    // O que o fornecedor confirmou entrou de facto na conta.
    if (!payment.heldById || payment.heldById === SYSTEM_ACTOR_ID) {
      throw new BadRequestException(
        'Só se anula uma confirmação feita à mão. Dinheiro confirmado pelo fornecedor devolve-se com um reembolso.',
      );
    }

    if (payment.heldById === adminId) {
      throw ApiErrors.forbidden(
        ErrorCode.MONEY_CONTROL_VIOLATION,
        'Quem confirmou a entrada não a anula. Pede a outro admin.',
      );
    }
    assertNotPartyToPayment(adminId, payment);

    if (payment.disputes.length > 0) {
      throw new BadRequestException(
        'Este pagamento tem uma disputa aberta. Decide-se na resolução da disputa.',
      );
    }

    const stillWaiting = payment.booking
      ? payment.booking.status === BookingStatus.CONFIRMED
      : payment.serviceBooking?.status === ServiceBookingStatus.PENDING;
    if (!stillWaiting) {
      throw new BadRequestException(
        'A reserva deste pagamento já avançou ou foi fechada. A confirmação já não se anula.',
      );
    }
  }

  private async assertAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para executar esta operação.',
      );
    }
  }
}
