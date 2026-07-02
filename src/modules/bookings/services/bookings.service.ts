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
  EquipmentStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { calculatePlatformFee } from '../../../shared/constants/fees';
import {
  CANCELLATION_FREE_WINDOW_HOURS,
  DEPOSIT_CLAIM_WINDOW_HOURS,
  LATE_CANCELLATION_RETENTION_PERCENT,
  PROVIDER_LISTINGS_SUSPENSION_DAYS,
  PROVIDER_STRIKE_LIMIT,
  PROVIDER_STRIKE_WINDOW_DAYS,
  roundMoney,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';
import { CreateBookingDto } from '../dto/create-booking.dto';
import { FindBookingsQueryDto } from '../dto/find-bookings-query.dto';
import { UpdateBookingStatusDto } from '../dto/update-booking-status.dto';
import { BookingPresenter } from '../presenters/booking.presenter';

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
  ) {}

  async create(clientId: string, dto: CreateBookingDto) {
    const equipmentId = dto.equipmentId.trim();

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      include: {
        owner: {
          select: { id: true, name: true, avatarUrl: true, pushToken: true },
        },
        category: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!equipment) throw new NotFoundException('Equipamento não encontrado.');
    if (equipment.status !== EquipmentStatus.ACTIVE)
      throw new BadRequestException(
        'Este equipamento não está disponível para reserva.',
      );
    if (equipment.availableQuantity <= 0)
      throw new BadRequestException('Este equipamento não está disponível.');
    if (equipment.ownerId === clientId)
      throw new BadRequestException(
        'Não podes reservar o teu próprio equipamento.',
      );

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Datas inválidas.');
    }

    const normalizedStartDate = this.startOfDay(startDate);
    const normalizedEndDate = this.startOfDay(endDate);
    const today = this.startOfDay(new Date());

    if (normalizedStartDate < today)
      throw new BadRequestException('A data inicial não pode ser no passado.');
    if (normalizedEndDate <= normalizedStartDate)
      throw new BadRequestException(
        'A data final deve ser maior que a data inicial.',
      );

    const totalDays = this.calculateTotalDays(
      normalizedStartDate,
      normalizedEndDate,
    );
    if (totalDays < 1)
      throw new BadRequestException('A reserva deve ter pelo menos 1 dia.');

    const rentalAmount = Number(equipment.pricePerDay) * totalDays;
    const depositAmount = Number(equipment.depositAmount ?? 0);
    const platformFee = this.calculatePlatformFee(rentalAmount);
    const totalAmount = rentalAmount + depositAmount + platformFee;

    const conflictWhere: Prisma.BookingWhereInput = {
      equipmentId: equipment.id,
      status: {
        in: [
          BookingStatus.PENDING,
          BookingStatus.CONFIRMED,
          BookingStatus.ACTIVE,
        ],
      },
      AND: [
        { startDate: { lt: normalizedEndDate } },
        { endDate: { gt: normalizedStartDate } },
      ],
    };

    try {
      const booking = await this.prisma.$transaction(
        async (tx) => {
          const conflictCount = await tx.booking.count({
            where: conflictWhere,
          });
          if (conflictCount >= equipment.quantity) {
            throw new BadRequestException(
              'Não há unidades disponíveis para este equipamento nesse período.',
            );
          }

          return tx.booking.create({
            data: {
              clientId,
              equipmentId: equipment.id,
              ownerId: equipment.ownerId,
              startDate: normalizedStartDate,
              endDate: normalizedEndDate,
              totalDays,
              rentalAmount,
              depositAmount,
              platformFee,
              totalAmount,
              deliveryAddress: dto.deliveryAddress?.trim() || null,
              clientNote: dto.clientNote?.trim() || null,
              status: BookingStatus.PENDING,
            },
            include: {
              client: { select: { id: true, name: true, avatarUrl: true } },
              owner: { select: { id: true, name: true, avatarUrl: true } },
              equipment: {
                select: { id: true, title: true, location: true, status: true },
              },
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 5000,
        },
      );

      if (equipment.owner.pushToken) {
        this.push
          .send({
            to: equipment.owner.pushToken,
            title: '📋 Nova reserva',
            body: `${booking.client.name} quer alugar "${equipment.title}"`,
            data: { type: 'booking_request', bookingId: booking.id },
          })
          .catch(() => {});
      }

      return {
        message: 'Reserva criada com sucesso.',
        data: BookingPresenter.toListItem(booking),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new BadRequestException(
          'Já existe uma reserva para este equipamento nesse período.',
        );
      }
      throw error;
    }
  }

  async findMyBookings(userId: string, query: FindBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const where: Prisma.BookingWhereInput =
      user.role === UserRole.ADMIN
        ? { ...(query.status ? { status: query.status } : {}) }
        : {
            clientId: userId,
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          equipment: {
            select: { id: true, title: true, location: true, status: true },
          },
          owner: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      message: 'Reservas obtidas com sucesso.',
      data: items.map((item) => BookingPresenter.toListItem(item)),
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

  async findOwnerBookings(userId: string, query: FindBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const where: Prisma.BookingWhereInput =
      user.role === UserRole.ADMIN
        ? { ...(query.status ? { status: query.status } : {}) }
        : {
            ownerId: userId,
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          equipment: {
            select: { id: true, title: true, location: true, status: true },
          },
          client: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      message: 'Reservas do proprietário obtidas com sucesso.',
      data: items.map((item) => BookingPresenter.toListItem(item)),
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

  async findOne(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        equipment: {
          select: {
            id: true,
            title: true,
            description: true,
            location: true,
            status: true,
            pricePerDay: true,
            depositAmount: true,
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            totalCharged: true,
            mpesaReference: true,
            receiptNumber: true,
            heldAt: true,
            releasedAt: true,
          },
        },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canView =
      user.role === UserRole.ADMIN ||
      booking.clientId === userId ||
      booking.ownerId === userId;
    if (!canView)
      throw new ForbiddenException('Não tens permissão para ver esta reserva.');

    return {
      message: 'Reserva obtida com sucesso.',
      data: BookingPresenter.toDetails(booking),
    };
  }

  async confirm(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        equipment: {
          select: {
            id: true,
            status: true,
            isAvailable: true,
            availableQuantity: true,
            quantity: true,
            title: true,
          },
        },
        client: { select: { id: true, name: true, pushToken: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canConfirm =
      user.role === UserRole.ADMIN || booking.ownerId === userId;
    if (!canConfirm)
      throw new ForbiddenException(
        'Não tens permissão para confirmar esta reserva.',
      );
    if (booking.status !== BookingStatus.PENDING)
      throw new BadRequestException(
        'Apenas reservas pendentes podem ser confirmadas.',
      );
    if (booking.equipment.status !== EquipmentStatus.ACTIVE)
      throw new BadRequestException(
        'Não é possível confirmar uma reserva de equipamento inativo.',
      );
    if (booking.equipment.availableQuantity <= 0)
      throw new BadRequestException(
        'Não há unidades disponíveis para confirmar esta reserva.',
      );

    // Verificações e decremento na MESMA transacção serializável para
    // impedir over-booking com dois confirms concorrentes (última unidade).
    let updatedBooking;
    try {
      updatedBooking = await this.prisma.$transaction(
        async (tx) => {
          const freshBooking = await tx.booking.findUnique({
            where: { id: bookingId },
            select: { status: true },
          });

          if (!freshBooking || freshBooking.status !== BookingStatus.PENDING) {
            throw new BadRequestException(
              'Apenas reservas pendentes podem ser confirmadas.',
            );
          }

          const freshEquipment = await tx.equipment.findUnique({
            where: { id: booking.equipmentId },
            select: { availableQuantity: true, quantity: true, status: true },
          });

          if (
            !freshEquipment ||
            freshEquipment.status !== EquipmentStatus.ACTIVE
          ) {
            throw new BadRequestException(
              'Não é possível confirmar uma reserva de equipamento inativo.',
            );
          }
          if (freshEquipment.availableQuantity <= 0) {
            throw new BadRequestException(
              'Não há unidades disponíveis para confirmar esta reserva.',
            );
          }

          const confirmedCount = await tx.booking.count({
            where: {
              id: { not: booking.id },
              equipmentId: booking.equipmentId,
              status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
              AND: [
                { startDate: { lt: booking.endDate } },
                { endDate: { gt: booking.startDate } },
              ],
            },
          });

          if (confirmedCount >= freshEquipment.quantity) {
            throw new BadRequestException(
              'Todas as unidades já estão reservadas para este período.',
            );
          }

          const confirmed = await tx.booking.update({
            where: { id: bookingId },
            data: { status: BookingStatus.CONFIRMED, confirmedAt: new Date() },
            include: {
              client: { select: { id: true, name: true, avatarUrl: true } },
              owner: { select: { id: true, name: true, avatarUrl: true } },
              equipment: {
                select: { id: true, title: true, location: true, status: true },
              },
            },
          });

          await tx.equipment.update({
            where: { id: booking.equipmentId },
            data: {
              availableQuantity: { decrement: 1 },
              isAvailable: freshEquipment.availableQuantity - 1 > 0,
            },
          });

          return confirmed;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 5000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new BadRequestException(
          'Outra confirmação está em curso para este equipamento. Tenta novamente.',
        );
      }
      throw error;
    }

    if (booking.client.pushToken) {
      this.push
        .send({
          to: booking.client.pushToken,
          title: '✅ Reserva confirmada',
          body: `${booking.owner.name} confirmou a tua reserva de "${booking.equipment.title}"`,
          data: { type: 'booking', bookingId: booking.id },
        })
        .catch(() => {});
    }

    return {
      message: 'Reserva confirmada com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  async cancel(userId: string, bookingId: string, dto: UpdateBookingStatusDto) {
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
            availableQuantity: true,
            quantity: true,
          },
        },
        client: {
          select: { id: true, name: true, avatarUrl: true, pushToken: true },
        },
        owner: {
          select: { id: true, name: true, avatarUrl: true, pushToken: true },
        },
        payment: { select: { id: true, status: true } },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canCancel =
      user.role === UserRole.ADMIN ||
      booking.clientId === userId ||
      booking.ownerId === userId;
    if (!canCancel)
      throw new ForbiddenException(
        'Não tens permissão para cancelar esta reserva.',
      );

    if (
      booking.status !== BookingStatus.PENDING &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new BadRequestException(
        'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
      );
    }

    const cancellationReason = dto.reason?.trim() || null;
    const wasConfirmed = booking.status === BookingStatus.CONFIRMED;
    const cancelledByClient = booking.clientId === userId;
    const cancelledByProvider = booking.ownerId === userId;

    // Política D2: cancelamento do cliente dentro da janela livre é grátis;
    // depois disso retém-se uma percentagem do rental para o provider.
    // Cancelamento do provider devolve tudo ao cliente e gera strike.
    const hoursUntilStart =
      (booking.startDate.getTime() - Date.now()) / (1000 * 60 * 60);
    const lateClientCancellation =
      cancelledByClient && hoursUntilStart < CANCELLATION_FREE_WINDOW_HOURS;

    const updatedBooking = await this.prisma.$transaction(
      async (tx) => {
        const freshBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });

        if (
          !freshBooking ||
          (freshBooking.status !== BookingStatus.PENDING &&
            freshBooking.status !== BookingStatus.CONFIRMED)
        ) {
          throw new BadRequestException(
            'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
          );
        }

        const cancelled = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason,
          },
          include: {
            client: { select: { id: true, name: true, avatarUrl: true } },
            owner: { select: { id: true, name: true, avatarUrl: true } },
            equipment: {
              select: { id: true, title: true, location: true, status: true },
            },
          },
        });

        if (wasConfirmed) {
          const freshEquipment = await tx.equipment.findUnique({
            where: { id: booking.equipmentId },
            select: { availableQuantity: true, quantity: true },
          });
          const restored = Math.min(
            (freshEquipment?.availableQuantity ?? 0) + 1,
            freshEquipment?.quantity ?? 1,
          );
          await tx.equipment.update({
            where: { id: booking.equipmentId },
            data: { availableQuantity: restored, isAvailable: restored > 0 },
          });
        }

        // Liquidação financeira do cancelamento.
        if (booking.payment) {
          const freshPayment = await tx.payment.findUnique({
            where: { id: booking.payment.id },
            select: {
              id: true,
              status: true,
              totalCharged: true,
              rentalAmount: true,
              depositStatus: true,
              clientId: true,
              ownerId: true,
            },
          });

          if (freshPayment?.status === PaymentStatus.PENDING) {
            await tx.payment.update({
              where: { id: freshPayment.id },
              data: { status: PaymentStatus.FAILED },
            });
          } else if (freshPayment?.status === PaymentStatus.HELD) {
            const totalCharged = Number(freshPayment.totalCharged);
            const depositReturn =
              freshPayment.depositStatus === DepositStatus.HELD
                ? {
                    depositStatus: DepositStatus.RETURNED,
                    depositReleasedAt: new Date(),
                  }
                : {};

            if (lateClientCancellation) {
              // Retenção tardia: parte do rental compensa o provider,
              // a plataforma cobra a fee sobre a parte retida,
              // o resto (incl. depósito e fee original) volta ao cliente.
              const retained = roundMoney(
                Number(freshPayment.rentalAmount) *
                  (LATE_CANCELLATION_RETENTION_PERCENT / 100),
              );
              const platformCut = calculatePlatformFee(retained);
              const providerCompensation = roundMoney(retained - platformCut);
              const clientRefund = roundMoney(totalCharged - retained);

              await this.ledger.recordMany(tx, [
                {
                  paymentId: freshPayment.id,
                  direction: LedgerDirection.OUTFLOW,
                  party: LedgerParty.CLIENT,
                  amount: clientRefund,
                  reason: `Reembolso de cancelamento tardio (retenção de ${LATE_CANCELLATION_RETENTION_PERCENT}% do rental).`,
                  actorId: userId,
                },
                {
                  paymentId: freshPayment.id,
                  direction: LedgerDirection.OUTFLOW,
                  party: LedgerParty.PROVIDER,
                  amount: providerCompensation,
                  reason:
                    'Compensação ao provider por cancelamento tardio do cliente.',
                  actorId: userId,
                },
                {
                  paymentId: freshPayment.id,
                  direction: LedgerDirection.OUTFLOW,
                  party: LedgerParty.PLATFORM,
                  amount: platformCut,
                  reason:
                    'Platform fee sobre a retenção de cancelamento tardio.',
                  actorId: userId,
                },
              ]);

              await this.payouts.createPending(tx, {
                paymentId: freshPayment.id,
                recipientId: freshPayment.clientId,
                kind: PayoutKind.CLIENT_REFUND,
                amount: clientRefund,
              });
              await this.payouts.createPending(tx, {
                paymentId: freshPayment.id,
                recipientId: freshPayment.ownerId,
                kind: PayoutKind.PROVIDER_PAYOUT,
                amount: providerCompensation,
              });

              await tx.payment.update({
                where: { id: freshPayment.id },
                data: {
                  status: PaymentStatus.PARTIALLY_REFUNDED,
                  refundedAt: new Date(),
                  refundAmount: clientRefund,
                  ownerPayout: providerCompensation,
                  ...depositReturn,
                },
              });
            } else {
              // Cancelamento grátis (cliente dentro da janela), do provider
              // ou do admin: devolve tudo ao cliente, incluindo a fee.
              await this.ledger.record(tx, {
                paymentId: freshPayment.id,
                direction: LedgerDirection.OUTFLOW,
                party: LedgerParty.CLIENT,
                amount: totalCharged,
                reason: 'Reembolso total por cancelamento da reserva.',
                actorId: userId,
              });

              await this.payouts.createPending(tx, {
                paymentId: freshPayment.id,
                recipientId: freshPayment.clientId,
                kind: PayoutKind.CLIENT_REFUND,
                amount: totalCharged,
              });

              await tx.payment.update({
                where: { id: freshPayment.id },
                data: {
                  status: PaymentStatus.REFUNDED,
                  refundedAt: new Date(),
                  refundAmount: totalCharged,
                  ownerPayout: 0,
                  ...depositReturn,
                },
              });
            }
          }
        }

        // Strike ao provider que cancela reserva confirmada (D2).
        if (
          cancelledByProvider &&
          wasConfirmed &&
          user.role !== UserRole.ADMIN
        ) {
          await tx.providerStrike.create({
            data: {
              userId: booking.ownerId,
              bookingId: booking.id,
              reason: 'Cancelamento de reserva confirmada.',
            },
          });

          const windowStart = new Date();
          windowStart.setDate(
            windowStart.getDate() - PROVIDER_STRIKE_WINDOW_DAYS,
          );

          const strikeCount = await tx.providerStrike.count({
            where: { userId: booking.ownerId, createdAt: { gte: windowStart } },
          });

          if (strikeCount >= PROVIDER_STRIKE_LIMIT) {
            const suspendedUntil = new Date();
            suspendedUntil.setDate(
              suspendedUntil.getDate() + PROVIDER_LISTINGS_SUSPENSION_DAYS,
            );

            await tx.user.update({
              where: { id: booking.ownerId },
              data: { listingsSuspendedUntil: suspendedUntil },
            });
            await tx.equipment.updateMany({
              where: {
                ownerId: booking.ownerId,
                status: EquipmentStatus.ACTIVE,
              },
              data: { isAvailable: false },
            });
          }
        }

        return cancelled;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      },
    );

    if (cancelledByProvider && wasConfirmed && user.role !== UserRole.ADMIN) {
      await this.audit.record({
        action: AuditAction.PROVIDER_STRIKE_ISSUED,
        actorId: userId,
        targetType: 'User',
        targetId: booking.ownerId,
        metadata: { bookingId: booking.id },
      });
    }

    if (cancelledByClient && booking.owner.pushToken) {
      this.push
        .send({
          to: booking.owner.pushToken,
          title: '❌ Reserva cancelada',
          body: `${booking.client.name} cancelou a reserva de "${booking.equipment.title}"`,
          data: { type: 'booking', bookingId: booking.id },
        })
        .catch(() => {});
    } else if (!cancelledByClient && booking.client.pushToken) {
      this.push
        .send({
          to: booking.client.pushToken,
          title: '❌ Reserva cancelada',
          body: `${booking.owner.name} cancelou a tua reserva de "${booking.equipment.title}"`,
          data: { type: 'booking', bookingId: booking.id },
        })
        .catch(() => {});
    }

    return {
      message: 'Reserva cancelada com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  /**
   * Checkpoint 2 (D1) — o provider confirma a devolução do equipamento em
   * boas condições: a reserva conclui e o depósito volta ao cliente.
   * (Para reclamar o depósito por dano, o provider abre uma disputa de
   * depósito ANTES de confirmar a devolução — POST /disputes/deposit-claim.)
   */
  async complete(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        equipment: {
          select: {
            id: true,
            title: true,
            availableQuantity: true,
            quantity: true,
          },
        },
        client: {
          select: { id: true, name: true, avatarUrl: true, pushToken: true },
        },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        payment: {
          select: {
            id: true,
            status: true,
            depositStatus: true,
            depositAmount: true,
            clientId: true,
          },
        },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canComplete =
      user.role === UserRole.ADMIN || booking.ownerId === userId;
    if (!canComplete)
      throw new ForbiddenException(
        'Não tens permissão para concluir esta reserva.',
      );
    if (booking.status !== BookingStatus.ACTIVE) {
      throw new BadRequestException(
        'Apenas reservas ativas (entrega confirmada) podem ser concluídas.',
      );
    }

    const updatedBooking = await this.prisma.$transaction(
      async (tx) => {
        const freshBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });

        if (!freshBooking || freshBooking.status !== BookingStatus.ACTIVE) {
          throw new BadRequestException(
            'Apenas reservas ativas (entrega confirmada) podem ser concluídas.',
          );
        }

        const completed = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.COMPLETED,
            returnConfirmedAt: new Date(),
          },
          include: {
            client: { select: { id: true, name: true, avatarUrl: true } },
            owner: { select: { id: true, name: true, avatarUrl: true } },
            equipment: {
              select: { id: true, title: true, location: true, status: true },
            },
          },
        });

        const freshEquipment = await tx.equipment.findUnique({
          where: { id: booking.equipmentId },
          select: { availableQuantity: true, quantity: true },
        });
        const restored = Math.min(
          (freshEquipment?.availableQuantity ?? 0) + 1,
          freshEquipment?.quantity ?? 1,
        );
        await tx.equipment.update({
          where: { id: booking.equipmentId },
          data: { availableQuantity: restored, isAvailable: restored > 0 },
        });

        // Devolução do depósito ao cliente (checkpoint 2 do escrow).
        if (booking.payment) {
          const freshPayment = await tx.payment.findUnique({
            where: { id: booking.payment.id },
            select: {
              id: true,
              status: true,
              depositStatus: true,
              depositAmount: true,
              clientId: true,
            },
          });

          if (
            freshPayment?.status === PaymentStatus.RELEASED &&
            freshPayment.depositStatus === DepositStatus.HELD
          ) {
            const depositAmount = roundMoney(
              Number(freshPayment.depositAmount),
            );

            await this.ledger.record(tx, {
              paymentId: freshPayment.id,
              direction: LedgerDirection.OUTFLOW,
              party: LedgerParty.CLIENT,
              amount: depositAmount,
              reason:
                'Depósito devolvido ao cliente após devolução confirmada.',
              actorId: userId,
            });

            await this.payouts.createPending(tx, {
              paymentId: freshPayment.id,
              recipientId: freshPayment.clientId,
              kind: PayoutKind.DEPOSIT_RETURN,
              amount: depositAmount,
            });

            await tx.payment.update({
              where: { id: freshPayment.id },
              data: {
                depositStatus: DepositStatus.RETURNED,
                depositReleasedAt: new Date(),
              },
            });
          }
        }

        return completed;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 8000,
      },
    );

    await this.audit.record({
      action: AuditAction.BOOKING_RETURN_CONFIRMED,
      actorId: userId,
      targetType: 'Booking',
      targetId: booking.id,
      metadata: {
        depositReturned: booking.payment?.depositStatus === DepositStatus.HELD,
      },
    });

    if (booking.client.pushToken) {
      this.push
        .send({
          to: booking.client.pushToken,
          title: '🎉 Aluguer concluído',
          body: `O aluguer de "${booking.equipment.title}" foi concluído e o teu depósito será devolvido. Deixa a tua avaliação!`,
          data: { type: 'booking', bookingId: booking.id },
        })
        .catch(() => {});
    }

    return {
      message: 'Devolução confirmada e reserva concluída com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  /**
   * D1 — auto-devolução do depósito: reservas ativas cujo prazo de
   * reclamação já passou sem o provider confirmar devolução nem reclamar.
   * Chamado pelo BookingsScheduler.
   */
  async autoReturnDepositsDue(): Promise<number> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - DEPOSIT_CLAIM_WINDOW_HOURS);

    const due = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.ACTIVE,
        endDate: { lte: cutoff },
        dispute: null,
        payment: {
          status: PaymentStatus.RELEASED,
        },
      },
      select: { id: true, ownerId: true },
      take: 50,
    });

    let processed = 0;

    for (const booking of due) {
      try {
        await this.complete(booking.ownerId, booking.id);
        await this.audit.record({
          action: AuditAction.DEPOSIT_AUTO_RETURNED,
          actorId: booking.ownerId,
          targetType: 'Booking',
          targetId: booking.id,
          metadata: { system: true, reason: 'deposit_claim_window_expired' },
        });
        processed += 1;
      } catch (error) {
        this.logger.warn(
          `Auto-devolução falhou para booking ${booking.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return processed;
  }

  private calculateTotalDays(startDate: Date, endDate: Date): number {
    const diffMs = endDate.getTime() - startDate.getTime();
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  private calculatePlatformFee(rentalAmount: number): number {
    return calculatePlatformFee(rentalAmount);
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
}
