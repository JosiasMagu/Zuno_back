import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { roundMoney } from '../../../shared/constants/policy';
import { ExecutePayoutDto } from '../dto/execute-payout.dto';
import { FailPayoutDto } from '../dto/fail-payout.dto';
import { FindPayoutsQueryDto } from '../dto/find-payouts-query.dto';
import {
  assertFourEyes,
  assertNotOwnPayout,
  fourEyesEnabled,
  payoutAutoMaxAmount,
} from '../money-controls';
import { PayoutPresenter } from '../presenters/payout.presenter';
import { newProviderReference } from '../providers/payment-provider';
import { PaymentNotifier } from './payment-notifier.service';

export type CreatePayoutInput = {
  paymentId: string;
  recipientId: string;
  kind: PayoutKind;
  amount: number;
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

/** O dinheiro que volta ao cliente sai para o número de onde entrou. */
const RETURNS_TO_PAYER: ReadonlySet<PayoutKind> = new Set([
  PayoutKind.CLIENT_REFUND,
  PayoutKind.DEPOSIT_RETURN,
]);

/** Resposta a quem perdeu a corrida: outro pedido mexeu no mesmo payout. */
function payoutConflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste payout ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

function referenceAlreadyUsed() {
  return ApiErrors.conflict(
    ErrorCode.PAYOUT_REFERENCE_ALREADY_USED,
    'Esta referência M-Pesa já está registada noutro payout.',
  );
}

function stillSending() {
  return new BadRequestException(
    'Este payout está a ser enviado pelo fornecedor. Espera pelo resultado antes de mexer nele.',
  );
}

/**
 * Fila de transferências para fora do escrow. A criação acontece dentro das
 * transacções financeiras (createPending). Com o fornecedor a enviar, o
 * PayoutDispatcher trata do envio; a execução manual fica para o modo manual
 * e para quando o fornecedor está em baixo, e regista sempre a referência.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifier: PaymentNotifier,
  ) {}

  /**
   * Cria um payout PENDING dentro da transacção do chamador.
   * Valores não positivos são ignorados (ex.: payout comprimido a zero
   * numa resolução parcial) e devolve null nesse caso.
   */
  async createPending(tx: Prisma.TransactionClient, input: CreatePayoutInput) {
    const amount = roundMoney(input.amount);
    if (amount <= 0) return null;

    const recipient = await tx.user.findUnique({
      where: { id: input.recipientId },
      select: { payoutMsisdn: true, phone: true },
    });

    // Um reembolso ou a devolução do depósito vai para o número que pagou,
    // que pode não ser o da conta. Sem esse número (pagamento simulado),
    // vale o de recebimento e, por fim, o telefone de registo.
    const payment = RETURNS_TO_PAYER.has(input.kind)
      ? await tx.payment.findUnique({
          where: { id: input.paymentId },
          select: { payerMsisdn: true },
        })
      : null;

    return tx.payout.create({
      data: {
        paymentId: input.paymentId,
        recipientId: input.recipientId,
        kind: input.kind,
        amount,
        msisdn:
          payment?.payerMsisdn ??
          recipient?.payoutMsisdn ??
          recipient?.phone ??
          null,
        status: PayoutStatus.PENDING,
      },
    });
  }

  async findAll(userId: string, query: FindPayoutsQueryDto) {
    await this.assertAdmin(userId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const autoMaxAmount = payoutAutoMaxAmount(this.config);

    const where: Prisma.PayoutWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: PAYOUT_INCLUDE,
      }),
      this.prisma.payout.count({ where }),
    ]);

    return {
      message: 'Payouts obtidos com sucesso.',
      data: items.map((item) =>
        PayoutPresenter.toListItem(item, { autoMaxAmount }),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  }

  async findMine(userId: string, query: FindPayoutsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: Prisma.PayoutWhereInput = {
      recipientId: userId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: PAYOUT_INCLUDE,
      }),
      this.prisma.payout.count({ where }),
    ]);

    return {
      message: 'Payouts obtidos com sucesso.',
      data: items.map((item) => PayoutPresenter.toListItem(item)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  }

  async execute(adminId: string, payoutId: string, dto: ExecutePayoutDto) {
    await this.assertAdmin(adminId);

    const executed = await this.executeWithReference(adminId, payoutId, dto);

    void this.notifier.payoutExecuted(executed.id);

    return {
      message: 'Payout marcado como executado.',
      data: PayoutPresenter.toListItem(executed),
    };
  }

  /**
   * Corre a execução numa transacção serializável. O índice único da
   * referência M-Pesa é a última barreira quando dois pedidos chegam ao
   * mesmo tempo com a mesma referência.
   */
  private async executeWithReference(
    adminId: string,
    payoutId: string,
    dto: ExecutePayoutDto,
  ) {
    try {
      return await runSerializable(
        this.prisma,
        (tx) => this.applyExecution(tx, adminId, payoutId, dto),
        payoutConflict,
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw referenceAlreadyUsed();
      }
      throw error;
    }
  }

  private async applyExecution(
    tx: Prisma.TransactionClient,
    adminId: string,
    payoutId: string,
    dto: ExecutePayoutDto,
  ) {
    const payout = await tx.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        status: true,
        msisdn: true,
        recipientId: true,
        paymentId: true,
        amount: true,
        kind: true,
        payment: { select: { heldById: true } },
      },
    });

    if (!payout) {
      throw new NotFoundException('Payout não encontrado.');
    }

    if (payout.status === PayoutStatus.SENDING) {
      throw stillSending();
    }

    if (payout.status !== PayoutStatus.PENDING) {
      throw new BadRequestException(
        'Apenas payouts pendentes podem ser executados.',
      );
    }

    assertNotOwnPayout(adminId, payout);
    assertFourEyes(fourEyesEnabled(this.config), adminId, payout.payment);

    const msisdn = dto.msisdn ?? payout.msisdn;
    if (!msisdn) {
      throw new BadRequestException(
        'O destinatário não tem número de recebimento definido. Informa o msisdn na execução.',
      );
    }

    const reused = await tx.payout.findFirst({
      where: { mpesaReference: dto.mpesaReference },
      select: { id: true },
    });
    if (reused) {
      throw referenceAlreadyUsed();
    }

    const executed = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: PayoutStatus.EXECUTED,
        msisdn,
        mpesaReference: dto.mpesaReference,
        executedById: adminId,
        executedAt: new Date(),
        failReason: null,
      },
      include: PAYOUT_INCLUDE,
    });

    // A transferência feita à mão fica na mesma tabela das que o fornecedor
    // faz, para a reconciliação ver todas as saídas no mesmo sítio.
    await tx.providerOperation.create({
      data: {
        provider: 'manual',
        kind: ProviderOperationKind.PAYOUT,
        reference: newProviderReference('MANUAL'),
        providerReference: dto.mpesaReference,
        payoutId,
        paymentId: payout.paymentId,
        amount: payout.amount,
        msisdn,
        status: ProviderOperationStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
    });

    await this.audit.record(
      {
        action: AuditAction.PAYOUT_EXECUTED,
        actorId: adminId,
        targetType: 'Payout',
        targetId: payoutId,
        amount: payout.amount,
        metadata: {
          mpesaReference: dto.mpesaReference,
          kind: payout.kind,
          recipientId: payout.recipientId,
          // Para onde o dinheiro foi, e se era o número que o destinatário
          // tinha registado quando o payout nasceu.
          msisdn,
          registeredMsisdn: payout.msisdn,
          msisdnOverridden: msisdn !== payout.msisdn,
        },
      },
      tx,
    );

    return executed;
  }

  async fail(adminId: string, payoutId: string, dto: FailPayoutDto) {
    await this.assertAdmin(adminId);

    const updated = await runSerializable(
      this.prisma,
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: { id: true, status: true },
        });

        if (!payout) {
          throw new NotFoundException('Payout não encontrado.');
        }

        if (payout.status === PayoutStatus.SENDING) {
          throw stillSending();
        }

        if (payout.status !== PayoutStatus.PENDING) {
          throw new BadRequestException(
            'Apenas payouts pendentes podem ser marcados como falhados.',
          );
        }

        const failed = await tx.payout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.FAILED,
            failReason: dto.reason.trim(),
          },
          include: PAYOUT_INCLUDE,
        });

        await this.audit.record(
          {
            action: AuditAction.PAYOUT_FAILED,
            actorId: adminId,
            targetType: 'Payout',
            targetId: failed.id,
            amount: failed.amount,
            metadata: { reason: failed.failReason },
          },
          tx,
        );

        return failed;
      },
      payoutConflict,
    );

    void this.notifier.payoutFailed(updated.id);

    return {
      message: 'Payout marcado como falhado.',
      data: PayoutPresenter.toListItem(updated),
    };
  }

  async retry(adminId: string, payoutId: string) {
    await this.assertAdmin(adminId);

    const updated = await runSerializable(
      this.prisma,
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: { id: true, status: true },
        });

        if (!payout) {
          throw new NotFoundException('Payout não encontrado.');
        }

        if (payout.status !== PayoutStatus.FAILED) {
          throw new BadRequestException(
            'Apenas payouts falhados podem ser recolocados na fila.',
          );
        }

        const retried = await tx.payout.update({
          where: { id: payoutId },
          data: { status: PayoutStatus.PENDING, failReason: null },
          include: PAYOUT_INCLUDE,
        });

        await this.audit.record(
          {
            action: AuditAction.PAYOUT_RETRIED,
            actorId: adminId,
            targetType: 'Payout',
            targetId: retried.id,
            amount: retried.amount,
          },
          tx,
        );

        return retried;
      },
      payoutConflict,
    );

    return {
      message: 'Payout recolocado na fila.',
      data: PayoutPresenter.toListItem(updated, {
        autoMaxAmount: payoutAutoMaxAmount(this.config),
      }),
    };
  }

  private async assertAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para executar esta operação.',
      );
    }
  }
}
