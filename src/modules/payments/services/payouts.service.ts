import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PayoutKind,
  PayoutStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { roundMoney } from '../../../shared/constants/policy';
import { ExecutePayoutDto } from '../dto/execute-payout.dto';
import { FailPayoutDto } from '../dto/fail-payout.dto';
import { FindPayoutsQueryDto } from '../dto/find-payouts-query.dto';
import { PayoutPresenter } from '../presenters/payout.presenter';

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

/**
 * Fila de transferências para fora do escrow (D3).
 * A criação acontece dentro das transacções financeiras (createPending);
 * a execução é manual pelo admin enquanto o M-Pesa B2C não existir,
 * mas fica sempre registada com referência.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cria um payout PENDING dentro da transacção do chamador.
   * Valores não positivos são ignorados (ex.: payout comprimido a zero
   * numa resolução parcial) — devolve null nesse caso.
   */
  async createPending(tx: Prisma.TransactionClient, input: CreatePayoutInput) {
    const amount = roundMoney(input.amount);
    if (amount <= 0) return null;

    const recipient = await tx.user.findUnique({
      where: { id: input.recipientId },
      select: { payoutMsisdn: true, phone: true },
    });

    return tx.payout.create({
      data: {
        paymentId: input.paymentId,
        recipientId: input.recipientId,
        kind: input.kind,
        amount,
        // Fallback para o telefone de registo quando o utilizador ainda
        // não definiu um número de recebimento dedicado.
        msisdn: recipient?.payoutMsisdn ?? recipient?.phone ?? null,
        status: PayoutStatus.PENDING,
      },
    });
  }

  async findAll(userId: string, query: FindPayoutsQueryDto) {
    await this.assertAdmin(userId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

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

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: { id: true, status: true, msisdn: true },
        });

        if (!payout) {
          throw new NotFoundException('Payout não encontrado.');
        }

        if (payout.status !== PayoutStatus.PENDING) {
          throw new BadRequestException(
            'Apenas payouts pendentes podem ser executados.',
          );
        }

        const msisdn = dto.msisdn?.trim() || payout.msisdn;
        if (!msisdn) {
          throw new BadRequestException(
            'O destinatário não tem número de recebimento definido. Informa o msisdn na execução.',
          );
        }

        return tx.payout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.EXECUTED,
            msisdn,
            mpesaReference: dto.mpesaReference.trim(),
            executedById: adminId,
            executedAt: new Date(),
            failReason: null,
          },
          include: PAYOUT_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 5000,
      },
    );

    await this.audit.record({
      action: AuditAction.PAYOUT_EXECUTED,
      actorId: adminId,
      targetType: 'Payout',
      targetId: updated.id,
      amount: updated.amount,
      metadata: {
        mpesaReference: updated.mpesaReference,
        kind: updated.kind,
        recipientId: updated.recipientId,
      },
    });

    return {
      message: 'Payout marcado como executado.',
      data: PayoutPresenter.toListItem(updated),
    };
  }

  async fail(adminId: string, payoutId: string, dto: FailPayoutDto) {
    await this.assertAdmin(adminId);

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const payout = await tx.payout.findUnique({
          where: { id: payoutId },
          select: { id: true, status: true },
        });

        if (!payout) {
          throw new NotFoundException('Payout não encontrado.');
        }

        if (payout.status !== PayoutStatus.PENDING) {
          throw new BadRequestException(
            'Apenas payouts pendentes podem ser marcados como falhados.',
          );
        }

        return tx.payout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.FAILED,
            failReason: dto.reason.trim(),
          },
          include: PAYOUT_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 5000,
      },
    );

    await this.audit.record({
      action: AuditAction.PAYOUT_FAILED,
      actorId: adminId,
      targetType: 'Payout',
      targetId: updated.id,
      amount: updated.amount,
      metadata: { reason: updated.failReason },
    });

    return {
      message: 'Payout marcado como falhado.',
      data: PayoutPresenter.toListItem(updated),
    };
  }

  async retry(adminId: string, payoutId: string) {
    await this.assertAdmin(adminId);

    const updated = await this.prisma.$transaction(
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

        return tx.payout.update({
          where: { id: payoutId },
          data: { status: PayoutStatus.PENDING, failReason: null },
          include: PAYOUT_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 5000,
      },
    );

    await this.audit.record({
      action: AuditAction.PAYOUT_RETRIED,
      actorId: adminId,
      targetType: 'Payout',
      targetId: updated.id,
      amount: updated.amount,
    });

    return {
      message: 'Payout recolocado na fila.',
      data: PayoutPresenter.toListItem(updated),
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
