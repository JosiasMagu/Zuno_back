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
  DisputeReason,
  DisputeStatus,
  DisputeType,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import {
  DEPOSIT_CLAIM_WINDOW_HOURS,
  roundMoney,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';
import { ClaimDepositDto } from '../dto/claim-deposit.dto';
import { CreateDisputeDto } from '../dto/create-dispute.dto';
import { FindDisputesQueryDto } from '../dto/find-disputes-query.dto';
import { ResolvePartialDto } from '../dto/resolve-partial.dto';
import { RespondDisputeDto } from '../dto/respond-dispute.dto';
import { DisputePresenter } from '../presenters/dispute.presenter';

const DISPUTE_FULL_INCLUDE = {
  booking: {
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      clientId: true,
      ownerId: true,
    },
  },
  serviceBooking: {
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      clientId: true,
      providerId: true,
    },
  },
  payment: {
    select: {
      id: true,
      status: true,
      totalCharged: true,
      receiptNumber: true,
      refundAmount: true,
    },
  },
  opener: { select: { id: true, name: true, avatarUrl: true } },
} as const;

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const bookingId = dto.bookingId?.trim();
    const serviceBookingId = dto.serviceBookingId?.trim();
    const paymentId = dto.paymentId!.trim();

    if ((!bookingId && !serviceBookingId) || (bookingId && serviceBookingId)) {
      throw new BadRequestException(
        'Forneça exactamente um de bookingId ou serviceBookingId.',
      );
    }

    if (bookingId) {
      return this.createBookingDispute(userId, bookingId, paymentId, dto);
    }
    return this.createServiceBookingDispute(
      userId,
      serviceBookingId as string,
      paymentId,
      dto,
    );
  }

  private async createBookingDispute(
    userId: string,
    bookingId: string,
    paymentId: string,
    dto: CreateDisputeDto,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, dispute: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (!booking.payment) {
      throw new BadRequestException(
        'Esta reserva ainda não possui pagamento associado.',
      );
    }

    const payment = booking.payment;

    if (payment.id !== paymentId) {
      throw new BadRequestException(
        'O pagamento informado não corresponde à reserva.',
      );
    }

    if (booking.clientId !== userId && booking.ownerId !== userId) {
      throw new ForbiddenException(
        'Não tens permissão para abrir disputa nesta reserva.',
      );
    }

    if (booking.dispute) {
      throw new BadRequestException(
        'Já existe uma disputa associada a esta reserva.',
      );
    }

    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite abrir disputa.',
      );
    }

    const dispute = await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.DISPUTED },
      });

      return tx.dispute.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          openedBy: userId,
          reason: dto.reason!,
          description: dto.description!.trim(),
          evidenceUrls: dto.evidenceUrls ?? [],
          status: DisputeStatus.AWAITING_OWNER,
          ownerDeadline: this.buildOwnerDeadline(),
        },
        include: DISPUTE_FULL_INCLUDE,
      });
    });

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DISPUTE_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      metadata: {
        bookingId: booking.id,
        paymentId: payment.id,
        reason: dto.reason,
      },
    });

    return {
      message: 'Disputa criada com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  private async createServiceBookingDispute(
    userId: string,
    serviceBookingId: string,
    paymentId: string,
    dto: CreateDisputeDto,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      include: { payment: true, dispute: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (!booking.payment) {
      throw new BadRequestException(
        'Esta reserva ainda não possui pagamento associado.',
      );
    }

    const payment = booking.payment;

    if (payment.id !== paymentId) {
      throw new BadRequestException(
        'O pagamento informado não corresponde à reserva.',
      );
    }

    if (booking.clientId !== userId && booking.providerId !== userId) {
      throw new ForbiddenException(
        'Não tens permissão para abrir disputa nesta reserva.',
      );
    }

    if (booking.dispute) {
      throw new BadRequestException(
        'Já existe uma disputa associada a esta reserva.',
      );
    }

    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite abrir disputa.',
      );
    }

    const dispute = await this.prisma.$transaction(async (tx) => {
      await tx.serviceBooking.update({
        where: { id: booking.id },
        data: { status: ServiceBookingStatus.DISPUTED },
      });

      return tx.dispute.create({
        data: {
          serviceBookingId: booking.id,
          paymentId: payment.id,
          openedBy: userId,
          reason: dto.reason!,
          description: dto.description!.trim(),
          evidenceUrls: dto.evidenceUrls ?? [],
          status: DisputeStatus.AWAITING_OWNER,
          ownerDeadline: this.buildOwnerDeadline(),
        },
        include: DISPUTE_FULL_INCLUDE,
      });
    });

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DISPUTE_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      metadata: {
        serviceBookingId: booking.id,
        paymentId: payment.id,
        reason: dto.reason,
      },
    });

    return {
      message: 'Disputa criada com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  /**
   * D1 — reclamação do depósito pelo provider (checkpoint 2).
   * Só possível com a reserva ACTIVE, pagamento RELEASED, depósito HELD,
   * e dentro da janela de reclamação após o fim do aluguer.
   * Vai directamente para UNDER_REVIEW: quem decide é o admin.
   */
  async claimDeposit(userId: string, dto: ClaimDepositDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: dto.bookingId.trim() },
      include: { payment: true, dispute: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (booking.ownerId !== userId) {
      throw new ForbiddenException(
        'Só o proprietário do equipamento pode reclamar o depósito.',
      );
    }

    if (booking.status !== BookingStatus.ACTIVE) {
      throw new BadRequestException(
        'O depósito só pode ser reclamado enquanto a reserva está ativa (antes de confirmar a devolução).',
      );
    }

    if (booking.dispute) {
      throw new BadRequestException(
        'Já existe uma disputa associada a esta reserva.',
      );
    }

    const payment = booking.payment;

    if (!payment || payment.status !== PaymentStatus.RELEASED) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite reclamar o depósito.',
      );
    }

    if (
      payment.depositStatus !== DepositStatus.HELD ||
      Number(payment.depositAmount) <= 0
    ) {
      throw new BadRequestException(
        'Esta reserva não tem depósito retido para reclamar.',
      );
    }

    const claimDeadline = new Date(booking.endDate);
    claimDeadline.setHours(
      claimDeadline.getHours() + DEPOSIT_CLAIM_WINDOW_HOURS,
    );

    if (new Date() > claimDeadline) {
      throw new BadRequestException(
        'A janela de reclamação do depósito já expirou.',
      );
    }

    const dispute = await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.DISPUTED },
      });

      return tx.dispute.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          openedBy: userId,
          type: DisputeType.DEPOSIT,
          reason: dto.reason ?? DisputeReason.DAMAGED,
          description: dto.description.trim(),
          evidenceUrls: dto.evidenceUrls ?? [],
          status: DisputeStatus.UNDER_REVIEW,
        },
        include: DISPUTE_FULL_INCLUDE,
      });
    });

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DEPOSIT_CLAIM_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      amount: payment.depositAmount,
      metadata: { bookingId: booking.id, paymentId: payment.id },
    });

    return {
      message:
        'Reclamação do depósito registada. Um administrador vai analisar.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  async findMyDisputes(userId: string, query: FindDisputesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const where =
      user.role === UserRole.ADMIN
        ? {
            ...(query.status ? { status: query.status } : {}),
          }
        : {
            OR: [
              { openedBy: userId },
              { booking: { clientId: userId } },
              { booking: { ownerId: userId } },
              { serviceBooking: { clientId: userId } },
              { serviceBooking: { providerId: userId } },
            ],
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: DISPUTE_FULL_INCLUDE,
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return {
      message: 'Disputas obtidas com sucesso.',
      data: items.map((item) => DisputePresenter.toListItem(item)),
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

  async findOne(userId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: DISPUTE_FULL_INCLUDE,
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const parties = this.disputeParties(dispute);

    const canAccess =
      user.role === UserRole.ADMIN ||
      dispute.openedBy === userId ||
      parties.clientId === userId ||
      parties.ownerId === userId;

    if (!canAccess) {
      throw new ForbiddenException('Não tens permissão para ver esta disputa.');
    }

    return {
      message: 'Disputa obtida com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  private disputeParties(dispute: {
    booking?: { clientId: string; ownerId: string } | null;
    serviceBooking?: { clientId: string; providerId: string } | null;
  }): { clientId: string | null; ownerId: string | null } {
    if (dispute.booking) {
      return {
        clientId: dispute.booking.clientId,
        ownerId: dispute.booking.ownerId,
      };
    }
    if (dispute.serviceBooking) {
      return {
        clientId: dispute.serviceBooking.clientId,
        ownerId: dispute.serviceBooking.providerId,
      };
    }
    return { clientId: null, ownerId: null };
  }

  async respond(userId: string, disputeId: string, dto: RespondDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        booking: { select: { ownerId: true } },
        serviceBooking: { select: { providerId: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const ownerId =
      dispute.booking?.ownerId ?? dispute.serviceBooking?.providerId ?? null;

    if (!ownerId) {
      throw new BadRequestException('Disputa sem reserva associada.');
    }

    const canRespond = user.role === UserRole.ADMIN || ownerId === userId;

    if (!canRespond) {
      throw new ForbiddenException(
        'Não tens permissão para responder a esta disputa.',
      );
    }

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.AWAITING_OWNER
    ) {
      throw new BadRequestException(
        'Esta disputa não pode mais receber resposta do owner.',
      );
    }

    const updatedDispute = await this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        ownerResponse: dto.ownerResponse.trim(),
        status: DisputeStatus.UNDER_REVIEW,
      },
      include: DISPUTE_FULL_INCLUDE,
    });

    await this.audit.record({
      action: AuditAction.DISPUTE_RESPONDED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
    });

    return {
      message: 'Resposta da disputa registrada com sucesso.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  async resolveClient(userId: string, disputeId: string) {
    await this.assertAdmin(userId);

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { booking: true, serviceBooking: true, payment: true },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (!dispute.booking && !dispute.serviceBooking) {
      throw new BadRequestException('Disputa sem reserva associada.');
    }

    this.assertPaymentResolvable(dispute.type, dispute.payment);

    const updatedDispute = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        if (fresh.type === DisputeType.PAYMENT) {
          // Cliente ganha a disputa do pagamento: reembolso total
          // (rental + fee + depósito) e a reserva é cancelada.
          if (dispute.booking) {
            await tx.booking.update({
              where: { id: dispute.booking.id },
              data: {
                status: BookingStatus.CANCELLED,
                cancelledAt: new Date(),
                cancellationReason:
                  'Cancelada por resolução de disputa a favor do cliente.',
              },
            });
            await this.restoreEquipmentUnit(tx, dispute.booking.equipmentId);
          } else if (dispute.serviceBooking) {
            await tx.serviceBooking.update({
              where: { id: dispute.serviceBooking.id },
              data: {
                status: ServiceBookingStatus.CANCELLED,
                cancelledAt: new Date(),
                cancellationReason:
                  'Cancelada por resolução de disputa a favor do cliente.',
              },
            });
          }

          const totalCharged = Number(fresh.payment.totalCharged);

          await this.ledger.record(tx, {
            paymentId: fresh.payment.id,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.CLIENT,
            amount: totalCharged,
            reason: 'Reembolso total por disputa resolvida a favor do cliente.',
            actorId: userId,
          });

          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.clientId,
            kind: PayoutKind.CLIENT_REFUND,
            amount: totalCharged,
          });

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              status: PaymentStatus.REFUNDED,
              refundedAt: new Date(),
              refundAmount: totalCharged,
              ownerPayout: 0,
              ...(fresh.payment.depositStatus === DepositStatus.HELD
                ? {
                    depositStatus: DepositStatus.RETURNED,
                    depositReleasedAt: new Date(),
                  }
                : {}),
            },
          });
        } else {
          // Disputa de DEPÓSITO: o cliente fica com o depósito de volta.
          const depositAmount = roundMoney(Number(fresh.payment.depositAmount));

          await tx.booking.update({
            where: { id: dispute.booking!.id },
            data: {
              status: BookingStatus.COMPLETED,
              returnConfirmedAt: new Date(),
            },
          });
          await this.restoreEquipmentUnit(tx, dispute.booking!.equipmentId);

          await this.ledger.record(tx, {
            paymentId: fresh.payment.id,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.CLIENT,
            amount: depositAmount,
            reason:
              'Depósito devolvido ao cliente por disputa resolvida a seu favor.',
            actorId: userId,
          });

          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.clientId,
            kind: PayoutKind.DEPOSIT_RETURN,
            amount: depositAmount,
          });

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              depositStatus: DepositStatus.RETURNED,
              depositReleasedAt: new Date(),
            },
          });
        }

        return tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_CLIENT,
            resolution: 'Resolvido a favor do cliente.',
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      },
    );

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_CLIENT,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount:
        dispute.type === DisputeType.DEPOSIT
          ? dispute.payment.depositAmount
          : dispute.payment.totalCharged,
      metadata: { type: dispute.type },
    });

    return {
      message: 'Disputa resolvida a favor do cliente.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  async resolveOwner(userId: string, disputeId: string) {
    await this.assertAdmin(userId);

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { booking: true, serviceBooking: true, payment: true },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (!dispute.booking && !dispute.serviceBooking) {
      throw new BadRequestException('Disputa sem reserva associada.');
    }

    this.assertPaymentResolvable(dispute.type, dispute.payment);

    const updatedDispute = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        if (fresh.type === DisputeType.PAYMENT) {
          // Owner ganha a disputa do pagamento: recebe o rental (menos fee),
          // o depósito volta ao cliente e a reserva conclui.
          if (dispute.booking) {
            await tx.booking.update({
              where: { id: dispute.booking.id },
              data: {
                status: BookingStatus.COMPLETED,
                returnConfirmedAt: new Date(),
              },
            });
            await this.restoreEquipmentUnit(tx, dispute.booking.equipmentId);
          } else if (dispute.serviceBooking) {
            await tx.serviceBooking.update({
              where: { id: dispute.serviceBooking.id },
              data: {
                status: ServiceBookingStatus.COMPLETED,
                completedAt: new Date(),
              },
            });
          }

          const providerPayout = roundMoney(
            Number(fresh.payment.ownerPayout ?? 0),
          );
          const depositAmount = roundMoney(
            Number(fresh.payment.depositAmount ?? 0),
          );
          const platformTake = roundMoney(
            Number(fresh.payment.totalCharged) - depositAmount - providerPayout,
          );

          await this.ledger.record(tx, {
            paymentId: fresh.payment.id,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.PROVIDER,
            amount: providerPayout,
            reason:
              'Rental liberado ao provider por disputa resolvida a seu favor.',
            actorId: userId,
          });

          if (platformTake > 0) {
            await this.ledger.record(tx, {
              paymentId: fresh.payment.id,
              direction: LedgerDirection.OUTFLOW,
              party: LedgerParty.PLATFORM,
              amount: platformTake,
              reason: 'Platform fee retida na resolução da disputa.',
              actorId: userId,
            });
          }

          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.ownerId,
            kind: PayoutKind.PROVIDER_PAYOUT,
            amount: providerPayout,
          });

          if (depositAmount > 0) {
            await this.ledger.record(tx, {
              paymentId: fresh.payment.id,
              direction: LedgerDirection.OUTFLOW,
              party: LedgerParty.CLIENT,
              amount: depositAmount,
              reason: 'Depósito devolvido ao cliente na resolução da disputa.',
              actorId: userId,
            });

            await this.payouts.createPending(tx, {
              paymentId: fresh.payment.id,
              recipientId: fresh.payment.clientId,
              kind: PayoutKind.DEPOSIT_RETURN,
              amount: depositAmount,
            });
          }

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              status: PaymentStatus.RELEASED,
              releasedAt: new Date(),
              depositStatus:
                depositAmount > 0 ? DepositStatus.RETURNED : DepositStatus.NONE,
              depositReleasedAt: new Date(),
            },
          });
        } else {
          // Disputa de DEPÓSITO: o provider fica com o depósito (dano).
          const depositAmount = roundMoney(Number(fresh.payment.depositAmount));

          await tx.booking.update({
            where: { id: dispute.booking!.id },
            data: {
              status: BookingStatus.COMPLETED,
              returnConfirmedAt: new Date(),
            },
          });
          await this.restoreEquipmentUnit(tx, dispute.booking!.equipmentId);

          await this.ledger.record(tx, {
            paymentId: fresh.payment.id,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.PROVIDER,
            amount: depositAmount,
            reason:
              'Depósito atribuído ao provider por disputa de dano resolvida a seu favor.',
            actorId: userId,
          });

          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.ownerId,
            kind: PayoutKind.DEPOSIT_CLAIM,
            amount: depositAmount,
          });

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              depositStatus: DepositStatus.CLAIMED,
              depositReleasedAt: new Date(),
            },
          });
        }

        return tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_OWNER,
            resolution: 'Resolvido a favor do owner.',
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      },
    );

    await this.audit.record({
      action:
        dispute.type === DisputeType.DEPOSIT
          ? AuditAction.DEPOSIT_CLAIMED
          : AuditAction.DISPUTE_RESOLVED_OWNER,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount:
        dispute.type === DisputeType.DEPOSIT
          ? dispute.payment.depositAmount
          : dispute.payment.totalCharged,
      metadata: { type: dispute.type },
    });

    return {
      message: 'Disputa resolvida a favor do owner.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  async resolvePartial(
    userId: string,
    disputeId: string,
    dto: ResolvePartialDto,
  ) {
    await this.assertAdmin(userId);

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { booking: true, serviceBooking: true, payment: true },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (!dispute.booking && !dispute.serviceBooking) {
      throw new BadRequestException('Disputa sem reserva associada.');
    }

    this.assertPaymentResolvable(dispute.type, dispute.payment);

    let auditAmount = 0;

    const updatedDispute = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        if (fresh.type === DisputeType.PAYMENT) {
          // Política D2: a percentagem aplica-se APENAS ao rental.
          // A fee fica com a plataforma; o depósito volta ao cliente.
          // Invariante: refund + payout + feeRetida = totalCharged − depósito.
          const rentalAmount = Number(fresh.payment.rentalAmount);
          const platformFee = Number(fresh.payment.platformFee);
          const depositAmount = roundMoney(
            Number(fresh.payment.depositAmount ?? 0),
          );
          const totalCharged = Number(fresh.payment.totalCharged);

          const refundAmount = roundMoney(
            (rentalAmount * dto.refundPercent) / 100,
          );
          const providerPayout = Math.max(
            0,
            roundMoney(rentalAmount - refundAmount - platformFee),
          );
          const platformRetained = roundMoney(
            totalCharged - depositAmount - refundAmount - providerPayout,
          );

          auditAmount = refundAmount;

          if (dispute.booking) {
            await tx.booking.update({
              where: { id: dispute.booking.id },
              data: {
                status: BookingStatus.COMPLETED,
                returnConfirmedAt: new Date(),
              },
            });
            await this.restoreEquipmentUnit(tx, dispute.booking.equipmentId);
          } else if (dispute.serviceBooking) {
            await tx.serviceBooking.update({
              where: { id: dispute.serviceBooking.id },
              data: {
                status: ServiceBookingStatus.COMPLETED,
                completedAt: new Date(),
              },
            });
          }

          await this.ledger.recordMany(tx, [
            {
              paymentId: fresh.payment.id,
              direction: LedgerDirection.OUTFLOW,
              party: LedgerParty.CLIENT,
              amount: refundAmount,
              reason: `Reembolso parcial de ${dto.refundPercent}% do rental por disputa.`,
              actorId: userId,
            },
            ...(providerPayout > 0
              ? [
                  {
                    paymentId: fresh.payment.id,
                    direction: LedgerDirection.OUTFLOW,
                    party: LedgerParty.PROVIDER,
                    amount: providerPayout,
                    reason:
                      'Rental remanescente liberado ao provider na resolução parcial.',
                    actorId: userId,
                  },
                ]
              : []),
            ...(platformRetained > 0
              ? [
                  {
                    paymentId: fresh.payment.id,
                    direction: LedgerDirection.OUTFLOW,
                    party: LedgerParty.PLATFORM,
                    amount: platformRetained,
                    reason: 'Platform fee retida na resolução parcial.',
                    actorId: userId,
                  },
                ]
              : []),
            ...(depositAmount > 0
              ? [
                  {
                    paymentId: fresh.payment.id,
                    direction: LedgerDirection.OUTFLOW,
                    party: LedgerParty.CLIENT,
                    amount: depositAmount,
                    reason:
                      'Depósito devolvido ao cliente na resolução parcial.',
                    actorId: userId,
                  },
                ]
              : []),
          ]);

          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.clientId,
            kind: PayoutKind.CLIENT_REFUND,
            amount: refundAmount,
          });
          await this.payouts.createPending(tx, {
            paymentId: fresh.payment.id,
            recipientId: fresh.payment.ownerId,
            kind: PayoutKind.PROVIDER_PAYOUT,
            amount: providerPayout,
          });
          if (depositAmount > 0) {
            await this.payouts.createPending(tx, {
              paymentId: fresh.payment.id,
              recipientId: fresh.payment.clientId,
              kind: PayoutKind.DEPOSIT_RETURN,
              amount: depositAmount,
            });
          }

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              status: PaymentStatus.PARTIALLY_REFUNDED,
              refundedAt: new Date(),
              releasedAt: new Date(),
              refundAmount,
              ownerPayout: providerPayout,
              depositStatus:
                depositAmount > 0 ? DepositStatus.RETURNED : DepositStatus.NONE,
              depositReleasedAt: new Date(),
            },
          });
        } else {
          // Disputa de DEPÓSITO: refundPercent é a parte do depósito que
          // volta ao CLIENTE; o resto vai ao provider.
          const depositAmount = roundMoney(Number(fresh.payment.depositAmount));
          const clientPart = roundMoney(
            (depositAmount * dto.refundPercent) / 100,
          );
          const providerPart = roundMoney(depositAmount - clientPart);

          auditAmount = clientPart;

          await tx.booking.update({
            where: { id: dispute.booking!.id },
            data: {
              status: BookingStatus.COMPLETED,
              returnConfirmedAt: new Date(),
            },
          });
          await this.restoreEquipmentUnit(tx, dispute.booking!.equipmentId);

          await this.ledger.recordMany(tx, [
            ...(clientPart > 0
              ? [
                  {
                    paymentId: fresh.payment.id,
                    direction: LedgerDirection.OUTFLOW,
                    party: LedgerParty.CLIENT,
                    amount: clientPart,
                    reason: `Parte do depósito (${dto.refundPercent}%) devolvida ao cliente.`,
                    actorId: userId,
                  },
                ]
              : []),
            ...(providerPart > 0
              ? [
                  {
                    paymentId: fresh.payment.id,
                    direction: LedgerDirection.OUTFLOW,
                    party: LedgerParty.PROVIDER,
                    amount: providerPart,
                    reason: 'Parte do depósito atribuída ao provider por dano.',
                    actorId: userId,
                  },
                ]
              : []),
          ]);

          if (clientPart > 0) {
            await this.payouts.createPending(tx, {
              paymentId: fresh.payment.id,
              recipientId: fresh.payment.clientId,
              kind: PayoutKind.DEPOSIT_RETURN,
              amount: clientPart,
            });
          }
          if (providerPart > 0) {
            await this.payouts.createPending(tx, {
              paymentId: fresh.payment.id,
              recipientId: fresh.payment.ownerId,
              kind: PayoutKind.DEPOSIT_CLAIM,
              amount: providerPart,
            });
          }

          await tx.payment.update({
            where: { id: fresh.payment.id },
            data: {
              depositStatus: DepositStatus.SPLIT,
              depositReleasedAt: new Date(),
            },
          });
        }

        return tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_PARTIAL,
            refundPercent: dto.refundPercent,
            resolution: `Resolvido parcialmente com reembolso de ${dto.refundPercent}%.`,
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      },
    );

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_PARTIAL,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: auditAmount,
      metadata: { refundPercent: dto.refundPercent, type: dispute.type },
    });

    return {
      message: 'Disputa resolvida parcialmente com sucesso.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  /**
   * Re-lê disputa+pagamento DENTRO da transacção e revalida o estado —
   * garante que duas resoluções concorrentes não passam ambas.
   */
  private async reloadForResolution(
    tx: Prisma.TransactionClient,
    disputeId: string,
  ) {
    const fresh = await tx.dispute.findUnique({
      where: { id: disputeId },
      select: {
        status: true,
        type: true,
        payment: {
          select: {
            id: true,
            status: true,
            depositStatus: true,
            totalCharged: true,
            rentalAmount: true,
            platformFee: true,
            depositAmount: true,
            ownerPayout: true,
            clientId: true,
            ownerId: true,
          },
        },
      },
    });

    if (!fresh) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(fresh.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    this.assertPaymentResolvable(fresh.type, fresh.payment);

    return fresh;
  }

  private assertPaymentResolvable(
    type: DisputeType,
    payment: { status: PaymentStatus; depositStatus: DepositStatus },
  ) {
    if (type === DisputeType.PAYMENT) {
      // Nunca resolver sobre RELEASED: seria desembolso duplo — o provider
      // já recebeu. Disputas de pagamento só existem enquanto HELD.
      if (payment.status !== PaymentStatus.HELD) {
        throw new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        );
      }
    } else {
      if (
        payment.status !== PaymentStatus.RELEASED ||
        payment.depositStatus !== DepositStatus.HELD
      ) {
        throw new BadRequestException(
          'O depósito desta disputa não está num estado válido para resolução.',
        );
      }
    }
  }

  private async restoreEquipmentUnit(
    tx: Prisma.TransactionClient,
    equipmentId: string,
  ) {
    const equipment = await tx.equipment.findUnique({
      where: { id: equipmentId },
      select: { availableQuantity: true, quantity: true },
    });

    if (!equipment) return;

    const restored = Math.min(
      equipment.availableQuantity + 1,
      equipment.quantity,
    );

    await tx.equipment.update({
      where: { id: equipmentId },
      data: { availableQuantity: restored, isAvailable: restored > 0 },
    });
  }

  private buildOwnerDeadline() {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 3);
    return deadline;
  }

  private isResolved(status: DisputeStatus) {
    return (
      status === DisputeStatus.RESOLVED_CLIENT ||
      status === DisputeStatus.RESOLVED_OWNER ||
      status === DisputeStatus.RESOLVED_PARTIAL
    );
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
