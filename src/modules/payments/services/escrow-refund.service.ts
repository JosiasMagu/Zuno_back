import { Injectable } from '@nestjs/common';
import {
  DepositStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
} from '@prisma/client';

import { LedgerService } from './ledger.service';
import { PayoutsService } from './payouts.service';

/** O que é preciso saber de um pagamento retido para o devolver por inteiro. */
export interface RefundablePayment {
  id: string;
  totalCharged: Prisma.Decimal;
  depositStatus: DepositStatus;
  clientId: string;
}

/** Quem pede a devolução e o motivo que fica escrito no ledger. */
export interface RefundContext {
  /** Null quando é o sistema a agir. */
  actorId: string | null;
  reason: string;
}

/** O que aconteceu ao pagamento de uma reserva que foi cancelada. */
export enum CancelledPaymentOutcome {
  /** Não havia pagamento por fechar. */
  NOTHING_TO_SETTLE = 'NOTHING_TO_SETTLE',
  /** O dinheiro não chegou a entrar e o pagamento ficou FAILED. */
  VOIDED = 'VOIDED',
  /** O dinheiro estava no escrow e voltou todo ao cliente. */
  REFUNDED = 'REFUNDED',
}

/**
 * Devolução total ao cliente.
 *
 * O reembolso feito pelo admin, o cancelamento de um aluguer sem penalização
 * e o cancelamento de um serviço fazem o mesmo movimento de dinheiro. Vive
 * aqui para as três situações não divergirem.
 */
@Injectable()
export class EscrowRefundService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
  ) {}

  /**
   * Tira do escrow tudo o que o cliente pagou, taxa incluída, cria o payout
   * do reembolso e fecha o pagamento como REFUNDED. Quem chama já confirmou,
   * dentro da mesma transacção, que o pagamento está HELD.
   */
  async refundInFull(
    tx: Prisma.TransactionClient,
    payment: RefundablePayment,
    context: RefundContext,
  ): Promise<void> {
    const totalCharged = Number(payment.totalCharged);

    await this.ledger.record(tx, {
      paymentId: payment.id,
      direction: LedgerDirection.OUTFLOW,
      party: LedgerParty.CLIENT,
      amount: totalCharged,
      reason: context.reason,
      actorId: context.actorId,
    });

    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.clientId,
      kind: PayoutKind.CLIENT_REFUND,
      amount: totalCharged,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.REFUNDED,
        refundedAt: new Date(),
        refundAmount: totalCharged,
        ownerPayout: 0,
        ...(payment.depositStatus === DepositStatus.HELD
          ? {
              depositStatus: DepositStatus.RETURNED,
              depositReleasedAt: new Date(),
            }
          : {}),
      },
    });
  }

  /**
   * Fecha o pagamento de uma reserva cancelada sem penalização para ninguém.
   * O pagamento que ainda não entrou fica FAILED, e o que está retido volta
   * todo ao cliente. Relê o estado dentro da transacção.
   */
  async settleCancelled(
    tx: Prisma.TransactionClient,
    paymentId: string,
    context: RefundContext,
  ): Promise<CancelledPaymentOutcome> {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        totalCharged: true,
        depositStatus: true,
        clientId: true,
      },
    });

    if (payment?.status === PaymentStatus.PENDING) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      return CancelledPaymentOutcome.VOIDED;
    }

    if (payment?.status !== PaymentStatus.HELD) {
      return CancelledPaymentOutcome.NOTHING_TO_SETTLE;
    }

    await this.refundInFull(tx, payment, context);
    return CancelledPaymentOutcome.REFUNDED;
  }
}
