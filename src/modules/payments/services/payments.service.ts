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
  UserRole,
} from '@prisma/client';
import * as crypto from 'crypto';

import { AuditService } from '../../../shared/audit/audit.service';
import { calculateProviderPayout } from '../../../shared/constants/fees';
import { PrismaService } from '../../../shared/db/prisma.service';
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';
import { FindPaymentsQueryDto } from '../dto/find-payments-query.dto';
import { PaymentPresenter } from '../presenters/payment.presenter';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async initiate(userId: string, bookingId: string, dto: InitiatePaymentDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        equipment: {
          select: {
            id: true,
            title: true,
            location: true,
            status: true,
            isAvailable: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        owner: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        payment: true,
        dispute: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (booking.clientId !== userId) {
      throw new ForbiddenException(
        'Não tens permissão para iniciar pagamento desta reserva.',
      );
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        'Apenas reservas confirmadas podem ter pagamento iniciado.',
      );
    }

    if (booking.dispute) {
      throw new BadRequestException(
        'Não é possível iniciar pagamento para uma reserva com disputa associada.',
      );
    }

    if (booking.payment) {
      throw new BadRequestException(
        'Já existe um pagamento associado a esta reserva.',
      );
    }

    const receiptNumber = await this.generateUniqueReceiptNumber();

    const payment = await this.prisma.payment.create({
      data: {
        bookingId: booking.id,
        clientId: booking.clientId,
        ownerId: booking.ownerId,
        rentalAmount: booking.rentalAmount,
        depositAmount: booking.depositAmount,
        platformFee: booking.platformFee,
        totalCharged: booking.totalAmount,
        ownerPayout: this.calculateOwnerPayout(
          Number(booking.rentalAmount),
          Number(booking.platformFee),
        ),
        currency: 'MZN',
        method: dto.method,
        status: PaymentStatus.PENDING,
        depositHeldAmount: booking.depositAmount,
        receiptNumber,
      },
      include: {
        booking: {
          select: {
            id: true,
            startDate: true,
            endDate: true,
            status: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        owner: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });

    await this.audit.record({
      action: AuditAction.PAYMENT_INITIATED,
      actorId: userId,
      targetType: 'Payment',
      targetId: payment.id,
      amount: payment.totalCharged,
      metadata: {
        bookingId: booking.id,
        method: dto.method,
        receiptNumber: payment.receiptNumber,
      },
    });

    return {
      message: 'Pagamento iniciado com sucesso.',
      data: PaymentPresenter.toListItem(payment),
    };
  }

  async findMyPayments(userId: string, query: FindPaymentsQueryDto) {
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
            OR: [{ clientId: userId }, { ownerId: userId }],
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
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
              startDate: true,
              endDate: true,
              status: true,
            },
          },
          owner: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
          client: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      message: 'Pagamentos obtidos com sucesso.',
      data: items.map((item) => PaymentPresenter.toListItem(item)),
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

  async findOne(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: {
            id: true,
            startDate: true,
            endDate: true,
            totalDays: true,
            status: true,
            deliveryAddress: true,
            clientNote: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        owner: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        dispute: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
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

    const canView =
      user.role === UserRole.ADMIN ||
      payment.clientId === userId ||
      payment.ownerId === userId;

    if (!canView) {
      throw new ForbiddenException(
        'Não tens permissão para ver este pagamento.',
      );
    }

    return {
      message: 'Pagamento obtido com sucesso.',
      data: PaymentPresenter.toDetails(payment),
    };
  }

  async markHeld(userId: string, paymentId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
      },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para marcar este pagamento como retido.',
      );
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
          },
        },
        dispute: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        'Apenas pagamentos pendentes podem ser marcados como retidos.',
      );
    }

    if (!payment.booking) {
      throw new BadRequestException(
        'Pagamento sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    if (payment.booking.status === BookingStatus.CANCELLED) {
      throw new BadRequestException(
        'Não é possível reter pagamento de uma reserva cancelada.',
      );
    }

    if (payment.dispute) {
      throw new BadRequestException(
        'Não é possível reter pagamento com disputa associada.',
      );
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.HELD,
        heldAt: new Date(),
      },
      include: {
        booking: {
          select: {
            id: true,
            startDate: true,
            endDate: true,
            status: true,
          },
        },
        client: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        owner: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });

    await this.audit.record({
      action: AuditAction.PAYMENT_MARKED_HELD,
      actorId: userId,
      targetType: 'Payment',
      targetId: updatedPayment.id,
      amount: updatedPayment.totalCharged,
    });

    return {
      message: 'Pagamento marcado como retido com sucesso.',
      data: PaymentPresenter.toListItem(updatedPayment),
    };
  }

  async release(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            ownerId: true,
          },
        },
        dispute: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
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

    // So o CLIENT (confirma recepcao do equipamento) ou ADMIN pode liberar.
    // O OWNER NUNCA pode liberar o seu proprio pagamento
    // isso quebraria a garantia central do cofre digital.
    const canRelease =
      user.role === UserRole.ADMIN || payment.clientId === userId;

    if (!canRelease) {
      throw new ForbiddenException(
        'Só o cliente que fez a reserva ou um administrador pode liberar o pagamento.',
      );
    }

    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'Apenas pagamentos retidos podem ser liberados.',
      );
    }

    if (!payment.booking) {
      throw new BadRequestException(
        'Pagamento sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    if (
      payment.booking.status !== BookingStatus.CONFIRMED &&
      payment.booking.status !== BookingStatus.ACTIVE
    ) {
      throw new BadRequestException(
        'O estado atual da reserva não permite liberação do pagamento.',
      );
    }

    if (payment.dispute) {
      throw new BadRequestException(
        'Não é possível liberar pagamento com disputa associada.',
      );
    }

    const bookingId = payment.booking.id;

    const updatedPayment = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.payment.findUnique({
          where: { id: paymentId },
          select: { status: true },
        });

        if (!fresh || fresh.status !== PaymentStatus.HELD) {
          throw new BadRequestException(
            'Apenas pagamentos retidos podem ser liberados.',
          );
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.COMPLETED },
        });

        return tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.RELEASED,
            releasedAt: new Date(),
            depositReleasedAt: new Date(),
          },
          include: {
            booking: {
              select: {
                id: true,
                startDate: true,
                endDate: true,
                status: true,
              },
            },
            client: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
              },
            },
            owner: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
              },
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 5000,
      },
    );

    await this.audit.record({
      action: AuditAction.PAYMENT_RELEASED,
      actorId: userId,
      targetType: 'Payment',
      targetId: updatedPayment.id,
      amount: updatedPayment.ownerPayout,
    });

    return {
      message: 'Pagamento liberado com sucesso.',
      data: PaymentPresenter.toListItem(updatedPayment),
    };
  }

  async refund(userId: string, paymentId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
      },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para reembolsar este pagamento.',
      );
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
          },
        },
        dispute: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    if (
      payment.status !== PaymentStatus.PENDING &&
      payment.status !== PaymentStatus.HELD
    ) {
      throw new BadRequestException(
        'Apenas pagamentos pendentes ou retidos podem ser reembolsados.',
      );
    }

    if (payment.dispute && payment.dispute.status !== 'RESOLVED_CLIENT') {
      throw new BadRequestException(
        'Pagamento com disputa só pode ser reembolsado quando a resolução favorecer o cliente.',
      );
    }

    if (!payment.booking) {
      throw new BadRequestException(
        'Pagamento sem reserva associada — fluxo de serviço ainda não suportado por este endpoint.',
      );
    }

    const [, updatedPayment] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: payment.booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: 'Reserva cancelada por reembolso do pagamento.',
        },
      }),
      this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
          refundAmount: payment.totalCharged,
        },
        include: {
          booking: {
            select: {
              id: true,
              startDate: true,
              endDate: true,
              status: true,
            },
          },
          client: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
            },
          },
          owner: {
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
      action: AuditAction.PAYMENT_REFUNDED,
      actorId: userId,
      targetType: 'Payment',
      targetId: updatedPayment.id,
      amount: updatedPayment.refundAmount,
    });

    return {
      message: 'Pagamento reembolsado com sucesso.',
      data: PaymentPresenter.toListItem(updatedPayment),
    };
  }

  private calculateOwnerPayout(rentalAmount: number, platformFee: number) {
    return calculateProviderPayout(rentalAmount, platformFee);
  }

  private async generateUniqueReceiptNumber() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const receiptNumber = this.buildReceiptNumber();

      const existing = await this.prisma.payment.findUnique({
        where: { receiptNumber },
      });

      if (!existing) {
        return receiptNumber;
      }
    }

    throw new BadRequestException(
      'Não foi possível gerar um número de recibo único.',
    );
  }

  private buildReceiptNumber() {
    const token = crypto
      .randomUUID()
      .replace(/-/g, '')
      .slice(0, 12)
      .toUpperCase();
    return `ZUNO-${token}`;
  }
}
