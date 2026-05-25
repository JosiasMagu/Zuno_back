import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  EquipmentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { calculatePlatformFee } from '../../../shared/constants/fees';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { CreateBookingDto } from '../dto/create-booking.dto';
import { FindBookingsQueryDto } from '../dto/find-bookings-query.dto';
import { UpdateBookingStatusDto } from '../dto/update-booking-status.dto';
import { BookingPresenter } from '../presenters/booking.presenter';

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  async create(clientId: string, dto: CreateBookingDto) {
    const equipmentId = dto.equipmentId.trim();

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true, pushToken: true } },
        category: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!equipment) throw new NotFoundException('Equipamento não encontrado.');
    if (equipment.status !== EquipmentStatus.ACTIVE) throw new BadRequestException('Este equipamento não está disponível para reserva.');
    if (!equipment.isAvailable) throw new BadRequestException('Este equipamento não está disponível.');
    if (equipment.ownerId === clientId) throw new BadRequestException('Não podes reservar o teu próprio equipamento.');

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Datas inválidas.');
    }

    const normalizedStartDate = this.startOfDay(startDate);
    const normalizedEndDate = this.startOfDay(endDate);
    const today = this.startOfDay(new Date());

    if (normalizedStartDate < today) throw new BadRequestException('A data inicial não pode ser no passado.');
    if (normalizedEndDate <= normalizedStartDate) throw new BadRequestException('A data final deve ser maior que a data inicial.');

    const totalDays = this.calculateTotalDays(normalizedStartDate, normalizedEndDate);
    if (totalDays < 1) throw new BadRequestException('A reserva deve ter pelo menos 1 dia.');

    const rentalAmount = Number(equipment.pricePerDay) * totalDays;
    const depositAmount = Number(equipment.depositAmount ?? 0);
    const platformFee = this.calculatePlatformFee(rentalAmount);
    const totalAmount = rentalAmount + depositAmount + platformFee;

    const conflictWhere: Prisma.BookingWhereInput = {
      equipmentId: equipment.id,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
      AND: [
        { startDate: { lt: normalizedEndDate } },
        { endDate: { gt: normalizedStartDate } },
      ],
    };

    try {
      const booking = await this.prisma.$transaction(
        async (tx) => {
          const conflict = await tx.booking.findFirst({ where: conflictWhere, select: { id: true } });
          if (conflict) throw new BadRequestException('Já existe uma reserva para este equipamento nesse período.');

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
              equipment: { select: { id: true, title: true, location: true, status: true } },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 5000 },
      );

      // Notifica o owner — nova reserva
      if (equipment.owner.pushToken) {
        this.push.send({
          to: equipment.owner.pushToken,
          title: '📋 Nova reserva',
          body: `${booking.client.name} quer alugar "${equipment.title}"`,
          data: { type: 'booking_request', bookingId: booking.id },
        }).catch(() => {});
      }

      return {
        message: 'Reserva criada com sucesso.',
        data: BookingPresenter.toListItem(booking),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new BadRequestException('Já existe uma reserva para este equipamento nesse período.');
      }
      throw error;
    }
  }

  async findMyBookings(userId: string, query: FindBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const where: Prisma.BookingWhereInput =
      user.role === UserRole.ADMIN
        ? { ...(query.status ? { status: query.status } : {}) }
        : { clientId: userId, ...(query.status ? { status: query.status } : {}) };

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          equipment: { select: { id: true, title: true, location: true, status: true } },
          owner: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      message: 'Reservas obtidas com sucesso.',
      data: items.map((item) => BookingPresenter.toListItem(item)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPreviousPage: page > 1 },
    };
  }

  async findOwnerBookings(userId: string, query: FindBookingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const where: Prisma.BookingWhereInput =
      user.role === UserRole.ADMIN
        ? { ...(query.status ? { status: query.status } : {}) }
        : { ownerId: userId, ...(query.status ? { status: query.status } : {}) };

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          equipment: { select: { id: true, title: true, location: true, status: true } },
          client: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      message: 'Reservas do proprietário obtidas com sucesso.',
      data: items.map((item) => BookingPresenter.toListItem(item)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPreviousPage: page > 1 },
    };
  }

  async findOne(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        equipment: {
          select: { id: true, title: true, description: true, location: true, status: true, pricePerDay: true, depositAmount: true },
        },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canView = user.role === UserRole.ADMIN || booking.clientId === userId || booking.ownerId === userId;
    if (!canView) throw new ForbiddenException('Não tens permissão para ver esta reserva.');

    return {
      message: 'Reserva obtida com sucesso.',
      data: BookingPresenter.toDetails(booking),
    };
  }

  async confirm(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        equipment: { select: { id: true, status: true, isAvailable: true, title: true } },
        client: { select: { id: true, name: true, pushToken: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canConfirm = user.role === UserRole.ADMIN || booking.ownerId === userId;
    if (!canConfirm) throw new ForbiddenException('Não tens permissão para confirmar esta reserva.');
    if (booking.status !== BookingStatus.PENDING) throw new BadRequestException('Apenas reservas pendentes podem ser confirmadas.');
    if (booking.equipment.status !== EquipmentStatus.ACTIVE) throw new BadRequestException('Não é possível confirmar uma reserva de equipamento inativo.');
    if (!booking.equipment.isAvailable) throw new BadRequestException('Não é possível confirmar reserva de equipamento indisponível.');

    const conflictingBooking = await this.prisma.booking.findFirst({
      where: {
        id: { not: booking.id },
        equipmentId: booking.equipmentId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.ACTIVE] },
        AND: [{ startDate: { lt: booking.endDate } }, { endDate: { gt: booking.startDate } }],
      },
    });

    if (conflictingBooking) throw new BadRequestException('Já existe outra reserva confirmada para este equipamento nesse período.');

    const [updatedBooking] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CONFIRMED, confirmedAt: new Date() },
        include: {
          client: { select: { id: true, name: true, avatarUrl: true } },
          owner: { select: { id: true, name: true, avatarUrl: true } },
          equipment: { select: { id: true, title: true, location: true, status: true } },
        },
      }),
      this.prisma.equipment.update({
        where: { id: booking.equipmentId },
        data: { isAvailable: false },
      }),
    ]);

    // Notifica o cliente — reserva confirmada
    if (booking.client.pushToken) {
      this.push.send({
        to: booking.client.pushToken,
        title: '✅ Reserva confirmada',
        body: `${booking.owner.name} confirmou a tua reserva de "${booking.equipment.title}"`,
        data: { type: 'booking', bookingId: booking.id },
      }).catch(() => {});
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
        equipment: { select: { id: true, title: true, location: true, status: true, isAvailable: true } },
        client: { select: { id: true, name: true, avatarUrl: true, pushToken: true } },
        owner: { select: { id: true, name: true, avatarUrl: true, pushToken: true } },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canCancel = user.role === UserRole.ADMIN || booking.clientId === userId || booking.ownerId === userId;
    if (!canCancel) throw new ForbiddenException('Não tens permissão para cancelar esta reserva.');

    if (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Apenas reservas pendentes ou confirmadas podem ser canceladas.');
    }

    const cancellationReason = dto.reason?.trim() || null;
    const wasConfirmed = booking.status === BookingStatus.CONFIRMED;
    const cancelledByClient = booking.clientId === userId;

    const [updatedBooking] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED, cancelledAt: new Date(), cancellationReason },
        include: {
          client: { select: { id: true, name: true, avatarUrl: true } },
          owner: { select: { id: true, name: true, avatarUrl: true } },
          equipment: { select: { id: true, title: true, location: true, status: true } },
        },
      }),
      ...(wasConfirmed ? [
        this.prisma.equipment.update({
          where: { id: booking.equipmentId },
          data: { isAvailable: true },
        }),
      ] : []),
    ]);

    // Notifica o outro interveniente
    if (cancelledByClient && booking.owner.pushToken) {
      this.push.send({
        to: booking.owner.pushToken,
        title: '❌ Reserva cancelada',
        body: `${booking.client.name} cancelou a reserva de "${booking.equipment.title}"`,
        data: { type: 'booking', bookingId: booking.id },
      }).catch(() => {});
    } else if (!cancelledByClient && booking.client.pushToken) {
      this.push.send({
        to: booking.client.pushToken,
        title: '❌ Reserva cancelada',
        body: `${booking.owner.name} cancelou a tua reserva de "${booking.equipment.title}"`,
        data: { type: 'booking', bookingId: booking.id },
      }).catch(() => {});
    }

    return {
      message: 'Reserva cancelada com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  async complete(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        equipment: { select: { id: true, title: true } },
        client: { select: { id: true, name: true, avatarUrl: true, pushToken: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const canComplete = user.role === UserRole.ADMIN || booking.ownerId === userId;
    if (!canComplete) throw new ForbiddenException('Não tens permissão para concluir esta reserva.');
    if (booking.status !== BookingStatus.CONFIRMED) throw new BadRequestException('Apenas reservas confirmadas podem ser concluídas.');

    const [updatedBooking] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.COMPLETED },
        include: {
          client: { select: { id: true, name: true, avatarUrl: true } },
          owner: { select: { id: true, name: true, avatarUrl: true } },
          equipment: { select: { id: true, title: true, location: true, status: true } },
        },
      }),
      this.prisma.equipment.update({
        where: { id: booking.equipmentId },
        data: { isAvailable: true },
      }),
    ]);

    // Notifica o cliente — reserva concluída
    if (booking.client.pushToken) {
      this.push.send({
        to: booking.client.pushToken,
        title: '🎉 Aluguer concluído',
        body: `O aluguer de "${booking.equipment.title}" foi concluído. Deixa a tua avaliação!`,
        data: { type: 'booking', bookingId: booking.id },
      }).catch(() => {});
    }

    return {
      message: 'Reserva concluída com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  // Helpers privados

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