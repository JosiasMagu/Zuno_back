import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  DepositStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';
import * as crypto from 'crypto';

import { AuditService } from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { calculateProviderPayout } from '../../../shared/constants/fees';
import {
  DELIVERY_AUTO_RELEASE_DAYS,
  roundMoney,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';
import { FindPaymentsQueryDto } from '../dto/find-payments-query.dto';
import { PaymentPresenter } from '../presenters/payment.presenter';
import { LedgerService } from './ledger.service';
import { PayoutsService } from './payouts.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
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
          serviceBooking: {
            select: {
              id: true,
              status: true,
              scheduledFor: true,
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
        serviceBooking: {
          select: {
            id: true,
            status: true,
            scheduledFor: true,
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
        booking: { select: { id: true, status: true } },
        serviceBooking: { select: { id: true, status: true } },
        dispute: { select: { id: true, status: true } },
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

    if (payment.booking) {
      if (payment.booking.status === BookingStatus.CANCELLED) {
        throw new BadRequestException(
          'Não é possível reter pagamento de uma reserva cancelada.',
        );
      }
    } else if (payment.serviceBooking) {
      if (payment.serviceBooking.status === ServiceBookingStatus.CANCELLED) {
        throw new BadRequestException(
          'Não é possível reter pagamento de uma reserva cancelada.',
        );
      }
    } else {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    if (payment.dispute) {
      throw new BadRequestException(
        'Não é possível reter pagamento com disputa associada.',
      );
    }

    const updatedPayment = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.payment.findUnique({
          where: { id: paymentId },
          select: { status: true, totalCharged: true, depositAmount: true },
        });

        if (!fresh || fresh.status !== PaymentStatus.PENDING) {
          throw new BadRequestException(
            'Apenas pagamentos pendentes podem ser marcados como retidos.',
          );
        }

        // Entrada do dinheiro do cliente no escrow.
        await this.ledger.record(tx, {
          paymentId,
          direction: LedgerDirection.INFLOW,
          party: LedgerParty.CLIENT,
          amount: Number(fresh.totalCharged),
          reason: 'Pagamento confirmado e retido no escrow.',
          actorId: userId,
        });

        return tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.HELD,
            heldAt: new Date(),
            depositStatus:
              Number(fresh.depositAmount) > 0
                ? DepositStatus.HELD
                : DepositStatus.NONE,
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
            serviceBooking: {
              select: {
                id: true,
                status: true,
                scheduledFor: true,
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
        booking: { select: { id: true, status: true, ownerId: true } },
        serviceBooking: {
          select: { id: true, status: true, providerId: true },
        },
        dispute: { select: { id: true, status: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    // Regra de ouro: so o CLIENT (que confirma a entrega/execucao) ou ADMIN
    // pode liberar. O PROVIDER NUNCA pode liberar o seu proprio pagamento.
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

    if (payment.dispute) {
      throw new BadRequestException(
        'Não é possível liberar pagamento com disputa associada.',
      );
    }

    const bookingId = payment.booking?.id ?? null;
    const serviceBookingId = payment.serviceBooking?.id ?? null;

    if (payment.booking) {
      // Checkpoint 1 (D1): o release acontece quando o cliente confirma a
      // recepção do equipamento — a reserva tem de estar CONFIRMED.
      if (payment.booking.status !== BookingStatus.CONFIRMED) {
        throw new BadRequestException(
          'O estado atual da reserva não permite liberação do pagamento.',
        );
      }
    } else if (payment.serviceBooking) {
      // Em servicos: a libertacao acontece depois do provider chamar
      // /service-bookings/:id/complete (status = COMPLETED) OU enquanto
      // ainda esta IN_PROGRESS (cliente confirma a entrega antecipadamente).
      if (
        payment.serviceBooking.status !== ServiceBookingStatus.IN_PROGRESS &&
        payment.serviceBooking.status !== ServiceBookingStatus.COMPLETED
      ) {
        throw new BadRequestException(
          'O estado atual da reserva de serviço não permite liberação do pagamento.',
        );
      }
    } else {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    const updatedPayment = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.payment.findUnique({
          where: { id: paymentId },
          select: {
            status: true,
            totalCharged: true,
            depositAmount: true,
            ownerPayout: true,
            ownerId: true,
            dispute: { select: { id: true } },
          },
        });

        if (!fresh || fresh.status !== PaymentStatus.HELD) {
          throw new BadRequestException(
            'Apenas pagamentos retidos podem ser liberados.',
          );
        }

        if (fresh.dispute) {
          throw new BadRequestException(
            'Não é possível liberar pagamento com disputa associada.',
          );
        }

        if (bookingId) {
          // Checkpoint 1: o equipamento está agora com o cliente.
          // O depósito continua retido até o provider confirmar a devolução.
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              status: BookingStatus.ACTIVE,
              deliveryConfirmedAt: new Date(),
            },
          });
        } else if (serviceBookingId) {
          await tx.serviceBooking.update({
            where: { id: serviceBookingId },
            data: {
              status: ServiceBookingStatus.COMPLETED,
              completedAt: new Date(),
            },
          });
        }

        const providerPayout = roundMoney(Number(fresh.ownerPayout ?? 0));
        const depositAmount = roundMoney(Number(fresh.depositAmount ?? 0));
        const platformTake = roundMoney(
          Number(fresh.totalCharged) - depositAmount - providerPayout,
        );

        await this.ledger.record(tx, {
          paymentId,
          direction: LedgerDirection.OUTFLOW,
          party: LedgerParty.PROVIDER,
          amount: providerPayout,
          reason: 'Rental liberado ao provider após confirmação de entrega.',
          actorId: userId,
        });

        if (platformTake > 0) {
          await this.ledger.record(tx, {
            paymentId,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.PLATFORM,
            amount: platformTake,
            reason: 'Platform fee retida na liberação do pagamento.',
            actorId: userId,
          });
        }

        await this.payouts.createPending(tx, {
          paymentId,
          recipientId: fresh.ownerId,
          kind: PayoutKind.PROVIDER_PAYOUT,
          amount: providerPayout,
        });

        const hasDeposit = bookingId !== null && depositAmount > 0;

        return tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.RELEASED,
            releasedAt: new Date(),
            // Sem depósito (ou serviço): nada fica retido após o release.
            ...(hasDeposit
              ? {}
              : {
                  depositStatus: DepositStatus.NONE,
                  depositReleasedAt: new Date(),
                }),
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
            serviceBooking: {
              select: {
                id: true,
                status: true,
                scheduledFor: true,
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

    this.metrics.businessEvents.inc({ event: 'payment_released' });

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
        booking: { select: { id: true, status: true } },
        serviceBooking: { select: { id: true, status: true } },
        dispute: { select: { id: true, status: true } },
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

    if (!payment.booking && !payment.serviceBooking) {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    const bookingId = payment.booking?.id ?? null;
    const serviceBookingId = payment.serviceBooking?.id ?? null;

    const updatedPayment = await this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.payment.findUnique({
          where: { id: paymentId },
          select: {
            status: true,
            totalCharged: true,
            depositStatus: true,
            clientId: true,
          },
        });

        if (
          !fresh ||
          (fresh.status !== PaymentStatus.PENDING &&
            fresh.status !== PaymentStatus.HELD)
        ) {
          throw new BadRequestException(
            'Apenas pagamentos pendentes ou retidos podem ser reembolsados.',
          );
        }

        if (bookingId) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              status: BookingStatus.CANCELLED,
              cancelledAt: new Date(),
              cancellationReason:
                'Reserva cancelada por reembolso do pagamento.',
            },
          });
        } else if (serviceBookingId) {
          await tx.serviceBooking.update({
            where: { id: serviceBookingId },
            data: {
              status: ServiceBookingStatus.CANCELLED,
              cancelledAt: new Date(),
              cancellationReason:
                'Reserva cancelada por reembolso do pagamento.',
            },
          });
        }

        // Só há dinheiro para devolver se ele chegou a entrar no escrow.
        if (fresh.status === PaymentStatus.HELD) {
          await this.ledger.record(tx, {
            paymentId,
            direction: LedgerDirection.OUTFLOW,
            party: LedgerParty.CLIENT,
            amount: Number(fresh.totalCharged),
            reason: 'Reembolso total ao cliente.',
            actorId: userId,
          });

          await this.payouts.createPending(tx, {
            paymentId,
            recipientId: fresh.clientId,
            kind: PayoutKind.CLIENT_REFUND,
            amount: Number(fresh.totalCharged),
          });
        }

        return tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.REFUNDED,
            refundedAt: new Date(),
            refundAmount: payment.totalCharged,
            ...(fresh.depositStatus === DepositStatus.HELD
              ? {
                  depositStatus: DepositStatus.RETURNED,
                  depositReleasedAt: new Date(),
                }
              : {}),
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
            serviceBooking: {
              select: {
                id: true,
                status: true,
                scheduledFor: true,
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

  /**
   * D1 — auto-release: pagamentos HELD cuja entrega não foi confirmada nem
   * disputada dentro do prazo são liberados automaticamente em nome do
   * cliente. Chamado pelo BookingsScheduler.
   */
  async autoReleaseDue(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DELIVERY_AUTO_RELEASE_DAYS);

    const due = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.HELD,
        dispute: null,
        booking: {
          status: BookingStatus.CONFIRMED,
          startDate: { lte: cutoff },
        },
      },
      select: { id: true, clientId: true },
      take: 50,
    });

    let released = 0;

    for (const payment of due) {
      try {
        await this.release(payment.clientId, payment.id);
        await this.audit.record({
          action: AuditAction.PAYMENT_AUTO_RELEASED,
          actorId: payment.clientId,
          targetType: 'Payment',
          targetId: payment.id,
          metadata: { system: true, reason: 'auto_release_deadline' },
        });
        released += 1;
      } catch (error) {
        this.logger.warn(
          `Auto-release falhou para payment ${payment.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return released;
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

  async initiateMock(userId: string, bookingId: string) {
    // GUARDA DE PRODUÇÃO: este endpoint contorna a confirmação real de
    // pagamento e só pode existir em ambientes de desenvolvimento/teste.
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'Pagamentos simulados não estão disponíveis neste ambiente.',
      );
    }

    // Inicia o pagamento com MPESA
    const result = await this.initiate(userId, bookingId, { method: 'MPESA' });
    const paymentId = result.data.id;

    // Simula referência M-Pesa
    const mpesaReference = `MP${Date.now().toString().slice(-8)}`;

    // Marca automaticamente como HELD (cofre), com o mesmo registo
    // contabilístico do fluxo real para manter a invariante do ledger.
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { totalCharged: true, depositAmount: true },
      });

      await this.ledger.record(tx, {
        paymentId,
        direction: LedgerDirection.INFLOW,
        party: LedgerParty.CLIENT,
        amount: Number(fresh!.totalCharged),
        reason: 'Pagamento simulado (mock) retido no escrow.',
        actorId: userId,
      });

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'HELD',
          heldAt: new Date(),
          mpesaReference,
          depositStatus:
            Number(fresh!.depositAmount) > 0
              ? DepositStatus.HELD
              : DepositStatus.NONE,
        },
      });
    });

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: { id: true, startDate: true, endDate: true, status: true },
        },
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    await this.audit.record({
      action: AuditAction.PAYMENT_MARKED_HELD,
      actorId: userId,
      targetType: 'Payment',
      targetId: paymentId,
      amount: payment!.totalCharged,
      metadata: { mock: true, mpesaReference },
    });

    return {
      message: 'Pagamento M-Pesa simulado com sucesso. Valor retido no cofre.',
      data: PaymentPresenter.toListItem(payment!),
    };
  }
}
