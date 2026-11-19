import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
} from '@prisma/client';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { AuditService } from '../../../shared/audit/audit.service';
import { PAYMENT_CONFIRMATION_WINDOW_HOURS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { DeclarePaymentDto } from '../dto/declare-payment.dto';
import { PaymentPresenter } from '../presenters/payment.presenter';

const HOUR_MS = 60 * 60 * 1000;

const DECLARED_PAYMENT_INCLUDE = {
  booking: {
    select: {
      id: true,
      startDate: true,
      endDate: true,
      status: true,
      expiresAt: true,
    },
  },
  serviceBooking: {
    select: { id: true, status: true, scheduledFor: true, expiresAt: true },
  },
  client: { select: { id: true, name: true, avatarUrl: true, phone: true } },
  owner: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.PaymentInclude;

/**
 * Pagamentos declarados pelo cliente.
 *
 * Enquanto a confirmação do M-Pesa for feita à mão, quem paga não controla
 * quando o admin confirma. O cliente declara a referência depois de pagar: a
 * reserva deixa de correr contra o prazo de pagamento e o admin ganha uma
 * janela para a confirmar no extracto. A declaração não move dinheiro nem
 * prova nada; só o mark-held do admin põe o pagamento no escrow.
 */
@Injectable()
export class PaymentDeclarationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async declare(userId: string, paymentId: string, dto: DeclarePaymentDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { clientId: true },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    // Declara quem paga aquela reserva, seja qual for o papel da conta.
    if (payment.clientId !== userId) {
      throw new ForbiddenException(
        'Só quem fez a reserva pode declarar este pagamento.',
      );
    }

    const declared = await runSerializable(
      this.prisma,
      (tx) => this.applyDeclaration(tx, paymentId, dto),
      () =>
        ApiErrors.conflict(
          ErrorCode.CONFLICT,
          'Outro pedido mexeu neste pagamento ao mesmo tempo. Actualiza e tenta de novo.',
        ),
    );

    await this.audit.record({
      action: AuditAction.PAYMENT_DECLARED,
      actorId: userId,
      targetType: 'Payment',
      targetId: paymentId,
      amount: declared.totalCharged,
      metadata: {
        mpesaReference: dto.mpesaReference,
        payerMsisdn: dto.payerMsisdn,
      },
    });

    return {
      message:
        'Pagamento declarado. A reserva fica à espera de ser confirmada no extracto.',
      data: PaymentPresenter.toDeclared(declared),
    };
  }

  /**
   * A fila do admin: pagamentos declarados e ainda por confirmar, do mais
   * antigo para o mais recente.
   */
  async findAwaitingConfirmation(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where: Prisma.PaymentWhereInput = {
      status: PaymentStatus.PENDING,
      declaredAt: { not: null },
    };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { declaredAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: DECLARED_PAYMENT_INCLUDE,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      message: 'Pagamentos por confirmar obtidos com sucesso.',
      data: items.map((item) => PaymentPresenter.toAwaitingConfirmation(item)),
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

  private async applyDeclaration(
    tx: Prisma.TransactionClient,
    paymentId: string,
    dto: DeclarePaymentDto,
  ) {
    const fresh = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        declaredAt: true,
        bookingId: true,
        serviceBookingId: true,
        booking: { select: { status: true } },
        serviceBooking: { select: { status: true } },
      },
    });

    if (fresh?.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        'Só se declara um pagamento que ainda não foi confirmado.',
      );
    }

    // Os mesmos estados em que o mark-held aceita o dinheiro.
    const reservationAwaitsPayment =
      fresh.booking?.status === BookingStatus.CONFIRMED ||
      fresh.serviceBooking?.status === ServiceBookingStatus.PENDING;

    if (!reservationAwaitsPayment) {
      throw new BadRequestException(
        'A reserva deste pagamento já não está à espera de pagamento.',
      );
    }

    const now = new Date();

    // Só a primeira declaração mexe no prazo. Corrigir a referência depois
    // não o estica outra vez.
    if (!fresh.declaredAt) {
      const confirmBy = new Date(
        now.getTime() + PAYMENT_CONFIRMATION_WINDOW_HOURS * HOUR_MS,
      );

      if (fresh.bookingId) {
        await tx.booking.update({
          where: { id: fresh.bookingId },
          data: { expiresAt: confirmBy },
        });
      }

      if (fresh.serviceBookingId) {
        await tx.serviceBooking.update({
          where: { id: fresh.serviceBookingId },
          data: { expiresAt: confirmBy },
        });
      }
    }

    return tx.payment.update({
      where: { id: paymentId },
      data: {
        declaredReference: dto.mpesaReference,
        declaredPayerMsisdn: dto.payerMsisdn,
        declaredAt: fresh.declaredAt ?? now,
      },
      include: DECLARED_PAYMENT_INCLUDE,
    });
  }
}
