import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  Prisma,
  ReviewAuthorRole,
  ServiceBookingStatus,
} from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateReviewDto } from '../dto/create-review.dto';
import { FindReviewsQueryDto } from '../dto/find-reviews-query.dto';
import { ReviewPresenter } from '../presenters/review.presenter';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
};

const REVIEWABLE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
];

const REVIEWABLE_SERVICE_BOOKING_STATUSES: ServiceBookingStatus[] = [
  ServiceBookingStatus.COMPLETED,
  ServiceBookingStatus.CANCELLED,
];

type TxClient = Prisma.TransactionClient;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateReviewDto) {
    const hasBooking = Boolean(dto.bookingId);
    const hasServiceBooking = Boolean(dto.serviceBookingId);

    if (hasBooking === hasServiceBooking) {
      throw new BadRequestException(
        'Forneça exactamente um de bookingId ou serviceBookingId.',
      );
    }

    if (hasBooking) {
      return this.createForBooking(userId, dto.bookingId as string, dto);
    }
    return this.createForServiceBooking(
      userId,
      dto.serviceBookingId as string,
      dto,
    );
  }

  private async createForBooking(
    userId: string,
    bookingId: string,
    dto: CreateReviewDto,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        clientId: true,
        ownerId: true,
        equipmentId: true,
        status: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (!REVIEWABLE_BOOKING_STATUSES.includes(booking.status)) {
      throw new BadRequestException(
        'Só é possível avaliar reservas concluídas ou canceladas.',
      );
    }

    this.assertAuthorRole(userId, dto.authorRole, {
      clientId: booking.clientId,
      providerId: booking.ownerId,
    });

    const existing = await this.prisma.review.findFirst({
      where: { bookingId, authorId: userId },
    });

    if (existing) {
      throw new BadRequestException(
        'Já submeteste uma avaliação para esta reserva.',
      );
    }

    const targetId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.equipmentId
        : booking.clientId;

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          bookingId,
          authorId: userId,
          targetId,
          authorRole: dto.authorRole,
          rating: dto.rating,
          comment: dto.comment,
        },
        include: { author: { select: AUTHOR_SELECT } },
      });

      if (dto.authorRole === ReviewAuthorRole.CLIENT) {
        await this.recalculateEquipmentRating(tx, booking.equipmentId);
        await this.recalculateUserRating(tx, booking.ownerId);
      } else {
        await this.recalculateUserRating(tx, booking.clientId);
      }

      return created;
    });

    return {
      message: 'Avaliação submetida com sucesso.',
      data: ReviewPresenter.toItem(review),
    };
  }

  private async createForServiceBooking(
    userId: string,
    serviceBookingId: string,
    dto: CreateReviewDto,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      select: {
        id: true,
        clientId: true,
        providerId: true,
        serviceId: true,
        status: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (!REVIEWABLE_SERVICE_BOOKING_STATUSES.includes(booking.status)) {
      throw new BadRequestException(
        'Só é possível avaliar reservas concluídas ou canceladas.',
      );
    }

    this.assertAuthorRole(userId, dto.authorRole, {
      clientId: booking.clientId,
      providerId: booking.providerId,
    });

    const existing = await this.prisma.review.findFirst({
      where: { serviceBookingId, authorId: userId },
    });

    if (existing) {
      throw new BadRequestException(
        'Já submeteste uma avaliação para esta reserva.',
      );
    }

    const targetId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.serviceId
        : booking.clientId;

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          serviceBookingId,
          authorId: userId,
          targetId,
          authorRole: dto.authorRole,
          rating: dto.rating,
          comment: dto.comment,
        },
        include: { author: { select: AUTHOR_SELECT } },
      });

      if (dto.authorRole === ReviewAuthorRole.CLIENT) {
        await this.recalculateServiceRating(tx, booking.serviceId);
        await this.recalculateUserRating(tx, booking.providerId);
      } else {
        await this.recalculateUserRating(tx, booking.clientId);
      }

      return created;
    });

    return {
      message: 'Avaliação submetida com sucesso.',
      data: ReviewPresenter.toItem(review),
    };
  }

  async findByEquipment(equipmentId: string, query: FindReviewsQueryDto) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    return this.paginate(
      {
        targetId: equipmentId,
        authorRole: ReviewAuthorRole.CLIENT,
        bookingId: { not: null },
      },
      query,
    );
  }

  async findByService(serviceId: string, query: FindReviewsQueryDto) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    return this.paginate(
      {
        targetId: serviceId,
        authorRole: ReviewAuthorRole.CLIENT,
        serviceBookingId: { not: null },
      },
      query,
    );
  }

  async findByUser(targetUserId: string, query: FindReviewsQueryDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    return this.paginate(
      {
        targetId: targetUserId,
        ...(query.authorRole ? { authorRole: query.authorRole } : {}),
      },
      query,
    );
  }

  async findMyReviews(userId: string, query: FindReviewsQueryDto) {
    const result = await this.paginate(
      {
        authorId: userId,
        ...(query.bookingId ? { bookingId: query.bookingId } : {}),
      },
      query,
    );
    return { ...result, message: 'As tuas avaliações obtidas com sucesso.' };
  }

  async canReview(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, clientId: true, ownerId: true, status: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    return this.evaluateCanReview({
      userId,
      participants: {
        clientId: booking.clientId,
        providerId: booking.ownerId,
      },
      statusAllowed: REVIEWABLE_BOOKING_STATUSES.includes(booking.status),
      existingReviewWhere: { bookingId, authorId: userId },
    });
  }

  async canReviewServiceBooking(userId: string, serviceBookingId: string) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      select: { id: true, clientId: true, providerId: true, status: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    return this.evaluateCanReview({
      userId,
      participants: {
        clientId: booking.clientId,
        providerId: booking.providerId,
      },
      statusAllowed: REVIEWABLE_SERVICE_BOOKING_STATUSES.includes(
        booking.status,
      ),
      existingReviewWhere: { serviceBookingId, authorId: userId },
    });
  }

  private assertAuthorRole(
    userId: string,
    role: ReviewAuthorRole,
    participants: { clientId: string; providerId: string },
  ) {
    const isClient = participants.clientId === userId;
    const isProvider = participants.providerId === userId;

    if (!isClient && !isProvider) {
      throw new ForbiddenException(
        'Não tens permissão para avaliar esta reserva.',
      );
    }

    if (role === ReviewAuthorRole.CLIENT && !isClient) {
      throw new ForbiddenException(
        'Só o cliente pode submeter uma avaliação com o papel CLIENT.',
      );
    }

    if (role === ReviewAuthorRole.PROVIDER && !isProvider) {
      throw new ForbiddenException(
        'Só o proprietário pode submeter uma avaliação com o papel OWNER.',
      );
    }
  }

  private async evaluateCanReview(params: {
    userId: string;
    participants: { clientId: string; providerId: string };
    statusAllowed: boolean;
    existingReviewWhere: Prisma.ReviewWhereInput;
  }) {
    const isParticipant =
      params.participants.clientId === params.userId ||
      params.participants.providerId === params.userId;

    if (!isParticipant) {
      return {
        message: 'Verificação concluída.',
        data: {
          canReview: false,
          reason: 'Não és participante desta reserva.',
        },
      };
    }

    if (!params.statusAllowed) {
      return {
        message: 'Verificação concluída.',
        data: {
          canReview: false,
          reason: 'A reserva ainda não está concluída ou cancelada.',
        },
      };
    }

    const existing = await this.prisma.review.findFirst({
      where: params.existingReviewWhere,
    });

    if (existing) {
      return {
        message: 'Verificação concluída.',
        data: { canReview: false, reason: 'Já avaliaste esta reserva.' },
      };
    }

    const role =
      params.participants.clientId === params.userId
        ? ReviewAuthorRole.CLIENT
        : ReviewAuthorRole.PROVIDER;

    return {
      message: 'Verificação concluída.',
      data: { canReview: true, role },
    };
  }

  private async paginate(
    where: Prisma.ReviewWhereInput,
    query: FindReviewsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { author: { select: AUTHOR_SELECT } },
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      message: 'Avaliações obtidas com sucesso.',
      data: items.map((item) => ReviewPresenter.toItem(item)),
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

  private async recalculateEquipmentRating(tx: TxClient, equipmentId: string) {
    const result = await tx.review.aggregate({
      where: {
        targetId: equipmentId,
        authorRole: ReviewAuthorRole.CLIENT,
        bookingId: { not: null },
      },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.equipment.update({
      where: { id: equipmentId },
      data: {
        totalRating: result._avg.rating ?? null,
        totalReviews: result._count.rating,
      },
    });
  }

  private async recalculateServiceRating(tx: TxClient, serviceId: string) {
    const result = await tx.review.aggregate({
      where: {
        targetId: serviceId,
        authorRole: ReviewAuthorRole.CLIENT,
        serviceBookingId: { not: null },
      },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.service.update({
      where: { id: serviceId },
      data: {
        totalRating: result._avg.rating ?? null,
        totalReviews: result._count.rating,
      },
    });
  }

  /**
   * Recalcula a média de avaliações de um utilizador.
   *
   * Um utilizador pode ser avaliado de várias formas:
   *
   *  1. **Como cliente** — quando um provider deixa uma review sobre ele
   *     (`targetId === userId`, `authorRole === OWNER`).
   *
   *  2. **Como provider de equipamentos** — clientes deixam reviews onde
   *     `targetId === equipmentId`. Para refletir a satisfação total do
   *     provider, agregamos sobre todas as reviews cujo booking tem
   *     `ownerId === userId`.
   *
   *  3. **Como provider de serviços** — análogo, via
   *     `serviceBooking.providerId === userId`.
   *
   * Antes esta função só considerava (1), pelo que o rating do provider
   * nunca subia no fluxo normal (não há review com `targetId === providerId`).
   */
  private async recalculateUserRating(tx: TxClient, userId: string) {
    const result = await tx.review.aggregate({
      where: {
        OR: [
          // (1) Avaliações directas (provider → cliente)
          { targetId: userId },
          // (2) Reviews de clientes a equipamentos deste provider
          {
            authorRole: ReviewAuthorRole.CLIENT,
            booking: { is: { ownerId: userId } },
          },
          // (3) Reviews de clientes a serviços deste provider
          {
            authorRole: ReviewAuthorRole.CLIENT,
            serviceBooking: { is: { providerId: userId } },
          },
        ],
      },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        totalRating: result._avg.rating ?? null,
        totalReviews: result._count.rating,
      },
    });
  }
}
