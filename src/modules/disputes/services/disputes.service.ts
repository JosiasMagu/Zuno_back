import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  DisputeStatus,
  PaymentStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateDisputeDto } from '../dto/create-dispute.dto';
import { FindDisputesQueryDto } from '../dto/find-disputes-query.dto';
import { ResolvePartialDto } from '../dto/resolve-partial.dto';
import { RespondDisputeDto } from '../dto/respond-dispute.dto';
import { DisputePresenter } from '../presenters/dispute.presenter';

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const bookingId = dto.bookingId.trim();
    const paymentId = dto.paymentId.trim();

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        dispute: true,
      },
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
        data: {
          status: BookingStatus.DISPUTED,
        },
      });

      return tx.dispute.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          openedBy: userId,
          reason: dto.reason,
          description: dto.description.trim(),
          status: DisputeStatus.AWAITING_OWNER,
          ownerDeadline: this.buildOwnerDeadline(),
        },
        include: {
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
          payment: {
            select: {
              id: true,
              status: true,
              totalCharged: true,
              receiptNumber: true,
              refundAmount: true,
            },
          },
          opener: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      });
    });

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

  async findMyDisputes(userId: string, query: FindDisputesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
      },
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
            ],
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
        include: {
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
          payment: {
            select: {
              id: true,
              status: true,
              totalCharged: true,
              receiptNumber: true,
              refundAmount: true,
            },
          },
          opener: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
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
      include: {
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
        payment: {
          select: {
            id: true,
            status: true,
            totalCharged: true,
            receiptNumber: true,
            refundAmount: true,
          },
        },
        opener: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (!dispute.booking) {
      throw new BadRequestException(
        'Disputa sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const canAccess =
      user.role === UserRole.ADMIN ||
      dispute.openedBy === userId ||
      dispute.booking.clientId === userId ||
      dispute.booking.ownerId === userId;

    if (!canAccess) {
      throw new ForbiddenException('Não tens permissão para ver esta disputa.');
    }

    return {
      message: 'Disputa obtida com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  async respond(userId: string, disputeId: string, dto: RespondDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        booking: {
          select: {
            ownerId: true,
          },
        },
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (!dispute.booking) {
      throw new BadRequestException(
        'Disputa sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const canRespond =
      user.role === UserRole.ADMIN || dispute.booking.ownerId === userId;

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
      include: {
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
        payment: {
          select: {
            id: true,
            status: true,
            totalCharged: true,
            receiptNumber: true,
            refundAmount: true,
          },
        },
        opener: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
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
      include: {
        booking: true,
        payment: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (
      dispute.payment.status !== PaymentStatus.HELD &&
      dispute.payment.status !== PaymentStatus.RELEASED
    ) {
      throw new BadRequestException(
        'O pagamento desta disputa não está num estado válido para resolução a favor do cliente.',
      );
    }

    if (!dispute.booking) {
      throw new BadRequestException(
        'Disputa sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const bookingId = dispute.booking.id;

    const [, , updatedDispute] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason:
            'Cancelada por resolução de disputa a favor do cliente.',
        },
      }),
      this.prisma.payment.update({
        where: { id: dispute.payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
          refundAmount: dispute.payment.totalCharged,
        },
      }),
      this.prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.RESOLVED_CLIENT,
          resolution: 'Resolvido a favor do cliente.',
        },
        include: {
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
          payment: {
            select: {
              id: true,
              status: true,
              totalCharged: true,
              receiptNumber: true,
              refundAmount: true,
            },
          },
          opener: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      }),
    ]);

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_CLIENT,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: dispute.payment.totalCharged,
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
      include: {
        booking: true,
        payment: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (
      dispute.payment.status !== PaymentStatus.HELD &&
      dispute.payment.status !== PaymentStatus.RELEASED
    ) {
      throw new BadRequestException(
        'O pagamento desta disputa não está num estado válido para resolução a favor do owner.',
      );
    }

    if (!dispute.booking) {
      throw new BadRequestException(
        'Disputa sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const ownerBookingId = dispute.booking.id;

    const [, , updatedDispute] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: ownerBookingId },
        data: {
          status: BookingStatus.COMPLETED,
        },
      }),
      dispute.payment.status === PaymentStatus.HELD
        ? this.prisma.payment.update({
            where: { id: dispute.payment.id },
            data: {
              status: PaymentStatus.RELEASED,
              releasedAt: new Date(),
              depositReleasedAt: new Date(),
            },
          })
        : this.prisma.payment.update({
            where: { id: dispute.payment.id },
            data: {},
          }),
      this.prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.RESOLVED_OWNER,
          resolution: 'Resolvido a favor do owner.',
        },
        include: {
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
          payment: {
            select: {
              id: true,
              status: true,
              totalCharged: true,
              receiptNumber: true,
              refundAmount: true,
            },
          },
          opener: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      }),
    ]);

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_OWNER,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: dispute.payment.totalCharged,
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
      include: {
        booking: true,
        payment: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    if (this.isResolved(dispute.status)) {
      throw new BadRequestException('Esta disputa já foi resolvida.');
    }

    if (
      dispute.payment.status !== PaymentStatus.HELD &&
      dispute.payment.status !== PaymentStatus.RELEASED
    ) {
      throw new BadRequestException(
        'O pagamento desta disputa não está num estado válido para resolução parcial.',
      );
    }

    if (!dispute.booking) {
      throw new BadRequestException(
        'Disputa sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const partialBookingId = dispute.booking.id;
    const totalCharged = Number(dispute.payment.totalCharged);
    const refundAmount = Number(
      ((totalCharged * dto.refundPercent) / 100).toFixed(2),
    );

    const [, , updatedDispute] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: partialBookingId },
        data: {
          status: BookingStatus.COMPLETED,
        },
      }),
      this.prisma.payment.update({
        where: { id: dispute.payment.id },
        data: {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          refundedAt: new Date(),
          refundAmount,
        },
      }),
      this.prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.RESOLVED_PARTIAL,
          refundPercent: dto.refundPercent,
          resolution: `Resolvido parcialmente com reembolso de ${dto.refundPercent}%.`,
        },
        include: {
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
          payment: {
            select: {
              id: true,
              status: true,
              totalCharged: true,
              receiptNumber: true,
              refundAmount: true,
            },
          },
          opener: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      }),
    ]);

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_PARTIAL,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: refundAmount,
      metadata: { refundPercent: dto.refundPercent },
    });

    return {
      message: 'Disputa resolvida parcialmente com sucesso.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
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
      select: {
        id: true,
        role: true,
      },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para executar esta operação.',
      );
    }
  }
}
