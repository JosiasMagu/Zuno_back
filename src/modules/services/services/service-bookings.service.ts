import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CancelServiceBookingDto } from '../dto/cancel-service-booking.dto';
import { FindServiceBookingsQueryDto } from '../dto/find-service-bookings-query.dto';
import { ServiceBookingPresenter } from '../presenters/service-booking.presenter';

const SERVICE_SELECT = { id: true, title: true } as const;
const USER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;
const PAYMENT_SELECT = {
  id: true,
  status: true,
  receiptNumber: true,
} as const;

@Injectable()
export class ServiceBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findMine(clientId: string, query: FindServiceBookingsQueryDto) {
    return this.findForUser({ clientId }, query);
  }

  async findForProvider(
    providerId: string,
    query: FindServiceBookingsQueryDto,
  ) {
    return this.findForUser({ providerId }, query);
  }

  async findOne(userId: string, bookingId: string) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: USER_SELECT },
        provider: { select: USER_SELECT },
        payment: { select: PAYMENT_SELECT },
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canAccess =
      user.role === UserRole.ADMIN ||
      booking.clientId === userId ||
      booking.providerId === userId;

    if (!canAccess) {
      throw new ForbiddenException('Não tens permissão para ver esta reserva.');
    }

    return {
      message: 'Reserva obtida com sucesso.',
      data: ServiceBookingPresenter.toItem(booking),
    };
  }

  async start(providerId: string, bookingId: string) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      include: {
        payment: { select: { id: true, status: true } },
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (booking.providerId !== providerId) {
      throw new ForbiddenException(
        'Apenas o provider da reserva pode iniciá-la.',
      );
    }

    if (booking.status !== ServiceBookingStatus.PENDING) {
      throw new BadRequestException(
        'Apenas reservas PENDING podem ser iniciadas.',
      );
    }

    if (!booking.payment || booking.payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'Só podes iniciar a execução com o pagamento em estado HELD.',
      );
    }

    const updated = await this.prisma.serviceBooking.update({
      where: { id: bookingId },
      data: {
        status: ServiceBookingStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: USER_SELECT },
        provider: { select: USER_SELECT },
        payment: { select: PAYMENT_SELECT },
      },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_STARTED,
      actorId: providerId,
      targetType: 'ServiceBooking',
      targetId: bookingId,
    });

    return {
      message: 'Execução iniciada com sucesso.',
      data: ServiceBookingPresenter.toItem(updated),
    };
  }

  async complete(providerId: string, bookingId: string) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      select: { id: true, providerId: true, status: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (booking.providerId !== providerId) {
      throw new ForbiddenException(
        'Apenas o provider da reserva pode concluí-la.',
      );
    }

    if (booking.status !== ServiceBookingStatus.IN_PROGRESS) {
      throw new BadRequestException(
        'Apenas reservas IN_PROGRESS podem ser concluídas.',
      );
    }

    const updated = await this.prisma.serviceBooking.update({
      where: { id: bookingId },
      data: {
        status: ServiceBookingStatus.COMPLETED,
        completedAt: new Date(),
      },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: USER_SELECT },
        provider: { select: USER_SELECT },
        payment: { select: PAYMENT_SELECT },
      },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_COMPLETED,
      actorId: providerId,
      targetType: 'ServiceBooking',
      targetId: bookingId,
    });

    return {
      message:
        'Execução concluída. O cliente deve agora confirmar a entrega e libertar o pagamento.',
      data: ServiceBookingPresenter.toItem(updated),
    };
  }

  async cancel(
    userId: string,
    bookingId: string,
    dto: CancelServiceBookingDto,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      include: {
        payment: { select: { id: true, status: true } },
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const isClient = booking.clientId === userId;
    const isProvider = booking.providerId === userId;
    const isAdmin = user.role === UserRole.ADMIN;

    if (!isClient && !isProvider && !isAdmin) {
      throw new ForbiddenException(
        'Não tens permissão para cancelar esta reserva.',
      );
    }

    if (
      booking.status === ServiceBookingStatus.COMPLETED ||
      booking.status === ServiceBookingStatus.CANCELLED ||
      booking.status === ServiceBookingStatus.DISPUTED
    ) {
      throw new BadRequestException(
        'A reserva já está concluída, cancelada ou em disputa.',
      );
    }

    if (
      booking.status === ServiceBookingStatus.IN_PROGRESS &&
      !isAdmin &&
      isClient
    ) {
      throw new BadRequestException(
        'Cliente não pode cancelar uma reserva em execução — abre uma disputa.',
      );
    }

    if (
      booking.payment &&
      booking.payment.status !== PaymentStatus.PENDING &&
      !isAdmin
    ) {
      throw new BadRequestException(
        'Com pagamento já retido ou liberado, o cancelamento exige ADMIN ou abertura de disputa.',
      );
    }

    const updated = await this.prisma.serviceBooking.update({
      where: { id: bookingId },
      data: {
        status: ServiceBookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: dto.reason?.trim() ?? null,
      },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: USER_SELECT },
        provider: { select: USER_SELECT },
        payment: { select: PAYMENT_SELECT },
      },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_CANCELLED,
      actorId: userId,
      targetType: 'ServiceBooking',
      targetId: bookingId,
      metadata: { reason: dto.reason ?? null },
    });

    return {
      message: 'Reserva cancelada com sucesso.',
      data: ServiceBookingPresenter.toItem(updated),
    };
  }

  private async findForUser(
    filter: Pick<Prisma.ServiceBookingWhereInput, 'clientId' | 'providerId'>,
    query: FindServiceBookingsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: Prisma.ServiceBookingWhereInput = { ...filter };
    if (query.status) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.prisma.serviceBooking.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          service: { select: SERVICE_SELECT },
          client: { select: USER_SELECT },
          provider: { select: USER_SELECT },
          payment: { select: PAYMENT_SELECT },
        },
      }),
      this.prisma.serviceBooking.count({ where }),
    ]);

    return {
      message: 'Reservas obtidas com sucesso.',
      data: items.map((item) => ServiceBookingPresenter.toItem(item)),
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
}
