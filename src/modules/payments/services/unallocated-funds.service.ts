import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  ProviderOperationKind,
  ProviderOperationStatus,
  UnallocatedReason,
  UnallocatedStatus,
  UserRole,
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
import {
  callProvider,
  newProviderReference,
  PAYMENT_PROVIDER,
  ProviderOutcome,
} from '../providers/payment-provider';
import type { PaymentProvider } from '../providers/payment-provider';
import { toProviderResponse } from '../providers/provider-response';

/** Dinheiro por atribuir, a registar dentro da transacção de quem o encontrou. */
export interface UnallocatedEntry {
  provider: string;
  providerReference: string;
  amount: number;
  payerMsisdn: string | null;
  paymentId: string | null;
  reason: UnallocatedReason;
  recordedById: string;
  note?: string;
}

/** O que o admin regista a partir do extracto. */
export interface UnallocatedFromStatement {
  mpesaReference: string;
  amount: number;
  payerMsisdn: string;
  paymentId?: string;
  note?: string;
}

const NOT_FOUND = 'Registo de dinheiro por atribuir não encontrado.';

function conflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste dinheiro ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

/**
 * Dinheiro que entrou na conta da plataforma e não fecha nenhum pagamento: o
 * valor não bate, é a parte a mais de um pagamento, chegou depois de a
 * reserva fechar, ou não se sabe a que pertence. Fica fora do escrow, à
 * espera de ser devolvido a quem pagou, e a reconciliação conta-o como
 * dinheiro na conta que não é da plataforma.
 */
@Injectable()
export class UnallocatedFundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Se esta transacção já está contada: fecha um pagamento ou está por
   * atribuir. O ID da transacção M-Pesa é o mesmo quer o admin o leia no
   * extracto (provider 'manual') quer chegue pela API, por isso compara-se só
   * a referência, sem o canal.
   */
  async isAccounted(
    tx: Prisma.TransactionClient,
    providerReference: string,
  ): Promise<boolean> {
    const payment = await tx.payment.findFirst({
      where: { mpesaReference: providerReference },
      select: { id: true },
    });
    if (payment) {
      return true;
    }

    const funds = await tx.unallocatedFunds.findFirst({
      where: { providerReference },
      select: { id: true },
    });
    return funds !== null;
  }

  /**
   * Regista dentro da transacção do chamador. A mesma transacção só se
   * regista uma vez, venha por que canal vier: um aviso repetido devolve o
   * registo que já existe.
   */
  async record(tx: Prisma.TransactionClient, entry: UnallocatedEntry) {
    const existing = await tx.unallocatedFunds.findFirst({
      where: { providerReference: entry.providerReference },
    });
    if (existing) {
      return existing;
    }

    const amount = roundMoney(entry.amount);
    const funds = await tx.unallocatedFunds.create({
      data: {
        provider: entry.provider,
        providerReference: entry.providerReference,
        amount,
        payerMsisdn: entry.payerMsisdn,
        paymentId: entry.paymentId,
        reason: entry.reason,
        recordedById: entry.recordedById,
        note: entry.note,
      },
    });

    await this.audit.record(
      {
        action: AuditAction.PAYMENT_UNALLOCATED_RECEIVED,
        actorId: entry.recordedById,
        targetType: 'UnallocatedFunds',
        targetId: funds.id,
        amount,
        metadata: {
          reason: entry.reason,
          paymentId: entry.paymentId,
          provider: entry.provider,
          providerReference: entry.providerReference,
        },
      },
      tx,
    );

    return funds;
  }

  /**
   * O admin regista uma entrada do extracto que não fecha nenhum pagamento,
   * por exemplo um cliente que pagou menos do que devia.
   */
  async registerFromStatement(adminId: string, dto: UnallocatedFromStatement) {
    await this.assertAdmin(adminId);

    const funds = await runSerializable(
      this.prisma,
      async (tx) => {
        if (await this.isAccounted(tx, dto.mpesaReference)) {
          throw ApiErrors.conflict(
            ErrorCode.PAYMENT_REFERENCE_ALREADY_USED,
            'Esta referência M-Pesa já está registada, num pagamento ou como dinheiro por atribuir.',
          );
        }

        if (dto.paymentId) {
          const payment = await tx.payment.findUnique({
            where: { id: dto.paymentId },
            select: { id: true },
          });
          if (!payment) {
            throw new NotFoundException('Pagamento não encontrado.');
          }
        }

        return this.record(tx, {
          provider: 'manual',
          providerReference: dto.mpesaReference,
          amount: dto.amount,
          payerMsisdn: dto.payerMsisdn,
          paymentId: dto.paymentId ?? null,
          reason: dto.paymentId
            ? UnallocatedReason.AMOUNT_MISMATCH
            : UnallocatedReason.UNKNOWN_REFERENCE,
          recordedById: adminId,
          note: dto.note,
        });
      },
      conflict,
    );

    return {
      message:
        'Dinheiro registado como por atribuir. Tem de ser devolvido a quem pagou.',
      data: this.present(funds),
    };
  }

  async list(
    adminId: string,
    query: { status?: UnallocatedStatus; page?: number; limit?: number },
  ) {
    await this.assertAdmin(adminId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UnallocatedFundsWhereInput = query.status
      ? { status: query.status }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.unallocatedFunds.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.unallocatedFunds.count({ where }),
    ]);

    return {
      message: 'Dinheiro por atribuir obtido com sucesso.',
      data: items.map((item) => this.present(item)),
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

  /** O admin devolveu o dinheiro à mão, por M-Pesa, e regista a referência. */
  async markReturned(
    adminId: string,
    id: string,
    dto: { returnReference: string; note?: string },
  ) {
    await this.assertAdmin(adminId);

    try {
      const funds = await runSerializable(
        this.prisma,
        async (tx) => {
          const fresh = await tx.unallocatedFunds.findUnique({ where: { id } });
          if (!fresh) throw new NotFoundException(NOT_FOUND);
          this.assertOpen(fresh.status);

          const returned = await tx.unallocatedFunds.update({
            where: { id },
            data: {
              status: UnallocatedStatus.RETURNED,
              returnReference: dto.returnReference,
              returnedById: adminId,
              returnedAt: new Date(),
              note: dto.note ?? fresh.note,
            },
          });

          // A devolução feita à mão fica com as outras transferências. O
          // índice único das operações recusa a mesma referência M-Pesa
          // numa segunda saída, seja payout ou devolução.
          await tx.providerOperation.create({
            data: {
              provider: 'manual',
              kind: ProviderOperationKind.RETURN,
              reference: newProviderReference('MANUAL'),
              providerReference: dto.returnReference,
              unallocatedId: id,
              amount: fresh.amount,
              msisdn: fresh.payerMsisdn,
              status: ProviderOperationStatus.CONFIRMED,
              confirmedAt: new Date(),
            },
          });

          await this.recordReturnAudit(tx, returned, adminId, 'manual');
          return returned;
        },
        conflict,
      );

      return {
        message: 'Devolução registada.',
        data: this.present(funds),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw ApiErrors.conflict(
          ErrorCode.PAYOUT_REFERENCE_ALREADY_USED,
          'Esta referência M-Pesa já está registada noutra transferência de saída.',
        );
      }
      throw error;
    }
  }

  /** Devolve pelo fornecedor, quando ele envia dinheiro. */
  async returnViaProvider(adminId: string, id: string) {
    await this.assertAdmin(adminId);

    if (!this.provider.transfers) {
      throw ApiErrors.badRequest(
        ErrorCode.PAYOUT_TRANSFER_UNAVAILABLE,
        'O envio automático ainda não está ligado. Devolve por M-Pesa e regista a referência.',
      );
    }

    const operation = await runSerializable(
      this.prisma,
      async (tx) => {
        const fresh = await tx.unallocatedFunds.findUnique({ where: { id } });
        if (!fresh) throw new NotFoundException(NOT_FOUND);
        this.assertOpen(fresh.status);

        if (!fresh.payerMsisdn) {
          throw new BadRequestException(
            'Não se sabe de que número veio este dinheiro. Devolve à mão e regista a referência.',
          );
        }

        await tx.unallocatedFunds.update({
          where: { id },
          data: { status: UnallocatedStatus.RETURNING, returnedById: adminId },
        });

        return tx.providerOperation.create({
          data: {
            provider: this.provider.name,
            kind: ProviderOperationKind.RETURN,
            reference: newProviderReference('RETURN'),
            unallocatedId: id,
            paymentId: fresh.paymentId,
            amount: fresh.amount,
            msisdn: fresh.payerMsisdn,
          },
        });
      },
      conflict,
    );

    const outcome = await callProvider(() =>
      this.provider.sendTransfer({
        reference: operation.reference,
        amount: Number(operation.amount),
        msisdn: operation.msisdn as string,
        description: 'ZUNO: devolução de um pagamento',
      }),
    );
    await this.settleReturn(operation.id, outcome);

    const funds = await this.prisma.unallocatedFunds.findUniqueOrThrow({
      where: { id },
    });

    return {
      message:
        funds.status === UnallocatedStatus.RETURNED
          ? 'Dinheiro devolvido.'
          : 'Devolução pedida ao fornecedor. O resultado chega em breve.',
      data: this.present(funds),
    };
  }

  /** Aplica o que o fornecedor disse de uma devolução. Repetir não faz nada. */
  async settleReturn(operationId: string, outcome: ProviderOutcome) {
    await runSerializable(
      this.prisma,
      async (tx) => {
        const operation = await tx.providerOperation.findUnique({
          where: { id: operationId },
        });
        if (
          !operation ||
          operation.kind !== ProviderOperationKind.RETURN ||
          !operation.unallocatedId ||
          operation.status === ProviderOperationStatus.CONFIRMED ||
          operation.status === ProviderOperationStatus.FAILED
        ) {
          return;
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
          const returned = await tx.unallocatedFunds.update({
            where: { id: operation.unallocatedId },
            data: {
              status: UnallocatedStatus.RETURNED,
              returnReference: outcome.providerReference,
              returnedAt: new Date(),
            },
          });
          await this.recordReturnAudit(
            tx,
            returned,
            returned.returnedById ?? SYSTEM_ACTOR_ID,
            operation.provider,
          );
          return;
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
          // Volta a estar por devolver, para o admin tentar outra vez.
          await tx.unallocatedFunds.update({
            where: { id: operation.unallocatedId },
            data: { status: UnallocatedStatus.OPEN },
          });
          return;
        }

        await tx.providerOperation.update({
          where: { id: operationId },
          data: {
            status:
              outcome.status === 'PENDING'
                ? ProviderOperationStatus.PENDING
                : ProviderOperationStatus.UNKNOWN,
            response: toProviderResponse(outcome),
          },
        });
      },
      conflict,
    );
  }

  private async recordReturnAudit(
    tx: Prisma.TransactionClient,
    funds: {
      id: string;
      amount: Prisma.Decimal;
      returnReference: string | null;
    },
    actorId: string,
    channel: string,
  ) {
    await this.audit.record(
      {
        action: AuditAction.PAYMENT_UNALLOCATED_RETURNED,
        actorId,
        targetType: 'UnallocatedFunds',
        targetId: funds.id,
        amount: funds.amount,
        metadata: { returnReference: funds.returnReference, channel },
      },
      tx,
    );
  }

  private assertOpen(status: UnallocatedStatus) {
    if (status === UnallocatedStatus.RETURNED) {
      throw new BadRequestException('Este dinheiro já foi devolvido.');
    }
    if (status === UnallocatedStatus.RETURNING) {
      throw new BadRequestException(
        'A devolução deste dinheiro já está em curso no fornecedor.',
      );
    }
  }

  private present(funds: {
    id: string;
    provider: string;
    providerReference: string;
    amount: Prisma.Decimal;
    payerMsisdn: string | null;
    paymentId: string | null;
    reason: UnallocatedReason;
    status: UnallocatedStatus;
    note: string | null;
    returnReference: string | null;
    returnedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: funds.id,
      provider: funds.provider,
      providerReference: funds.providerReference,
      amount: Number(funds.amount),
      payerMsisdn: funds.payerMsisdn,
      paymentId: funds.paymentId,
      reason: funds.reason,
      status: funds.status,
      note: funds.note,
      returnReference: funds.returnReference,
      returnedAt: funds.returnedAt,
      createdAt: funds.createdAt,
    };
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
