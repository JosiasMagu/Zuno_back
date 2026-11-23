import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  PayoutKind,
  PayoutStatus,
  ProviderOperationKind,
  ProviderOperationStatus,
  UserRole,
} from '@prisma/client';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { itemFailureOf } from '../../../shared/scheduling/job-failures';
import { processDue } from '../../../shared/scheduling/process-due';
import {
  assertFourEyes,
  assertNotOwnPayout,
  fourEyesEnabled,
  payoutAutoMaxAmount,
} from '../money-controls';
import {
  callProvider,
  newProviderReference,
  PAYMENT_PROVIDER,
  ProviderOutcome,
} from '../providers/payment-provider';
import type { PaymentProvider } from '../providers/payment-provider';
import { toProviderResponse } from '../providers/provider-response';
import { PayoutPresenter } from '../presenters/payout.presenter';
import { PaymentNotifier } from './payment-notifier.service';

/** Quantos payouts o job envia de cada vez. */
const BATCH_SIZE = 20;

/** O que o destinatário vê na transferência. */
const DESCRIPTION: Record<PayoutKind, string> = {
  [PayoutKind.PROVIDER_PAYOUT]: 'ZUNO: pagamento de aluguer ou servico',
  [PayoutKind.CLIENT_REFUND]: 'ZUNO: reembolso',
  [PayoutKind.DEPOSIT_RETURN]: 'ZUNO: devolucao do deposito',
  [PayoutKind.DEPOSIT_CLAIM]: 'ZUNO: deposito atribuido',
};

const PAYOUT_INCLUDE = {
  recipient: {
    select: { id: true, name: true, phone: true, payoutMsisdn: true },
  },
  payment: {
    select: {
      id: true,
      receiptNumber: true,
      bookingId: true,
      serviceBookingId: true,
    },
  },
} as const;

function payoutConflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste payout ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

/**
 * Envio dos payouts pelo fornecedor. Até um valor configurável saem sozinhos;
 * acima disso esperam pela aprovação de um admin. Cada envio reserva o
 * payout (SENDING) antes de chamar o fornecedor, por isso dois jobs ou dois
 * admins nunca enviam o mesmo payout duas vezes. Um envio sem resposta fica
 * SENDING até o fornecedor dizer o que aconteceu.
 */
@Injectable()
export class PayoutDispatcher {
  private readonly logger = new Logger(PayoutDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: PaymentNotifier,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Valor até ao qual um payout sai sem aprovação. */
  autoMaxAmount(): number {
    return payoutAutoMaxAmount(this.config);
  }

  fourEyes(): boolean {
    return fourEyesEnabled(this.config);
  }

  /** Envia os payouts que podem sair sozinhos. Chamado pelo scheduler. */
  async dispatchDue(): Promise<number> {
    if (!this.provider.transfers) {
      return 0;
    }

    const autoMax = this.autoMaxAmount();

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.payout.findMany({
          where: {
            id: { notIn: seenIds },
            status: PayoutStatus.PENDING,
            msisdn: { not: null },
            // Para uma conta suspensa nada sai sozinho: espera por um admin.
            recipient: { isActive: true },
            OR: [{ amount: { lte: autoMax } }, { approvedAt: { not: null } }],
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: BATCH_SIZE,
        }),
      handle: async (payout) => {
        await this.send(payout.id, SYSTEM_ACTOR_ID);
      },
      onFailure: itemFailureOf('payout-dispatch'),
    });
  }

  /**
   * Um admin aprova um payout acima do valor automático. Com o fornecedor a
   * enviar, o payout sai logo; no modo manual fica aprovado para o admin o
   * executar à mão.
   */
  async approve(adminId: string, payoutId: string) {
    await this.assertAdmin(adminId);

    await runSerializable(
      this.prisma,
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: {
            id: true,
            status: true,
            recipientId: true,
            amount: true,
            approvedAt: true,
            payment: { select: { heldById: true } },
          },
        });

        if (!payout) throw new NotFoundException('Payout não encontrado.');
        if (payout.status !== PayoutStatus.PENDING) {
          throw new BadRequestException(
            'Apenas payouts pendentes podem ser aprovados.',
          );
        }
        if (payout.approvedAt) {
          throw new BadRequestException('Este payout já foi aprovado.');
        }

        assertNotOwnPayout(adminId, payout);
        assertFourEyes(this.fourEyes(), adminId, payout.payment);

        await tx.payout.update({
          where: { id: payoutId },
          data: { approvedById: adminId, approvedAt: new Date() },
        });

        await this.audit.record(
          {
            action: AuditAction.PAYOUT_APPROVED,
            actorId: adminId,
            targetType: 'Payout',
            targetId: payoutId,
            amount: payout.amount,
          },
          tx,
        );
      },
      payoutConflict,
    );

    if (this.provider.transfers) {
      await this.send(payoutId, adminId);
    }

    const payout = await this.prisma.payout.findUniqueOrThrow({
      where: { id: payoutId },
      include: PAYOUT_INCLUDE,
    });

    return {
      message: this.provider.transfers
        ? 'Payout aprovado e enviado ao fornecedor.'
        : 'Payout aprovado. Executa-o depois de fazeres a transferência.',
      data: PayoutPresenter.toListItem(payout),
    };
  }

  /**
   * Reserva o payout e envia-o. Se outro pedido o reservou primeiro, não
   * faz nada.
   */
  async send(payoutId: string, actorId: string): Promise<void> {
    const claimed = await runSerializable(
      this.prisma,
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: {
            id: true,
            status: true,
            amount: true,
            msisdn: true,
            kind: true,
            paymentId: true,
          },
        });

        if (payout?.status !== PayoutStatus.PENDING || !payout.msisdn) {
          return null;
        }

        await tx.payout.update({
          where: { id: payoutId },
          data: { status: PayoutStatus.SENDING },
        });

        const operation = await tx.providerOperation.create({
          data: {
            provider: this.provider.name,
            kind: ProviderOperationKind.PAYOUT,
            reference: newProviderReference('PAYOUT'),
            payoutId,
            paymentId: payout.paymentId,
            amount: payout.amount,
            msisdn: payout.msisdn,
          },
        });

        return { operation, kind: payout.kind };
      },
      payoutConflict,
    );

    if (!claimed) {
      return;
    }

    const { operation, kind } = claimed;
    const outcome = await callProvider(() =>
      this.provider.sendTransfer({
        reference: operation.reference,
        amount: Number(operation.amount),
        msisdn: operation.msisdn as string,
        description: DESCRIPTION[kind],
      }),
    );

    await this.settle(operation.id, outcome, actorId);
  }

  /** Aplica o que o fornecedor disse de um envio. Repetir não faz nada. */
  async settle(
    operationId: string,
    outcome: ProviderOutcome,
    actorId: string = SYSTEM_ACTOR_ID,
  ): Promise<void> {
    const result = await runSerializable(
      this.prisma,
      async (tx) => {
        const operation = await tx.providerOperation.findUnique({
          where: { id: operationId },
        });

        if (
          !operation?.payoutId ||
          operation.kind !== ProviderOperationKind.PAYOUT ||
          operation.status === ProviderOperationStatus.CONFIRMED ||
          operation.status === ProviderOperationStatus.FAILED
        ) {
          return null;
        }

        const payoutId = operation.payoutId;

        if (outcome.status === 'CONFIRMED') {
          const payout = await tx.payout.findUniqueOrThrow({
            where: { id: payoutId },
            select: { approvedById: true, amount: true },
          });

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

          await tx.payout.update({
            where: { id: payoutId },
            data: {
              status: PayoutStatus.EXECUTED,
              mpesaReference: outcome.providerReference,
              executedById: payout.approvedById ?? actorId,
              executedAt: new Date(),
              failReason: null,
            },
          });

          await this.audit.record(
            {
              action: AuditAction.PAYOUT_SENT,
              actorId: payout.approvedById ?? actorId,
              targetType: 'Payout',
              targetId: payoutId,
              amount: payout.amount,
              metadata: {
                provider: operation.provider,
                reference: operation.reference,
                providerReference: outcome.providerReference,
                msisdn: operation.msisdn,
              },
            },
            tx,
          );

          return { payoutId, executed: true };
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

          await tx.payout.update({
            where: { id: payoutId },
            data: {
              status: PayoutStatus.FAILED,
              failReason: `${outcome.reason} (${outcome.code})`,
            },
          });

          await this.audit.record(
            {
              action: AuditAction.PAYOUT_FAILED,
              actorId,
              targetType: 'Payout',
              targetId: payoutId,
              amount: operation.amount,
              metadata: { code: outcome.code, reason: outcome.reason },
            },
            tx,
          );

          return { payoutId, executed: false };
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
      payoutConflict,
    );

    if (result?.executed) {
      void this.notifier.payoutExecuted(result.payoutId);
    } else if (result) {
      void this.notifier.payoutFailed(result.payoutId);
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
