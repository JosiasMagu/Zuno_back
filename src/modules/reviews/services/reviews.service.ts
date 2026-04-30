import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, ReviewAuthorRole } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateReviewDto } from '../dto/create-review.dto';
import { FindReviewsQueryDto } from '../dto/find-reviews-query.dto';
import { ReviewPresenter } from '../presenters/review.presenter';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
};

// Statuses que permitem avaliar
const REVIEWABLE_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
];

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Submeter avaliação ───────────────────────────────────────────────────

  async create(userId: string, dto: CreateReviewDto) {
    // 1. Buscar a booking com todos os dados necessários
    const booking = await this.prisma.booking.findUnique({
      where: { id: dto.bookingId },
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

    // 2. Verificar se o status permite avaliação
    if (!REVIEWABLE_STATUSES.includes(booking.status)) {
      throw new BadRequestException(
        'Só é possível avaliar reservas concluídas ou canceladas.',
      );
    }

    // 3. Verificar se o utilizador é parte da booking e se o papel é coerente
    const isClient = booking.clientId === userId;
    const isOwner = booking.ownerId === userId;

    if (!isClient && !isOwner) {
      throw new ForbiddenException(
        'Não tens permissão para avaliar esta reserva.',
      );
    }

    if (dto.authorRole === ReviewAuthorRole.CLIENT && !isClient) {
      throw new ForbiddenException(
        'Só o cliente pode submeter uma avaliação com o papel CLIENT.',
      );
    }

    if (dto.authorRole === ReviewAuthorRole.OWNER && !isOwner) {
      throw new ForbiddenException(
        'Só o proprietário pode submeter uma avaliação com o papel OWNER.',
      );
    }

    // 4. Verificar se já avaliou esta booking (unicidade por bookingId + authorId)
    const existing = await this.prisma.review.findUnique({
      where: {
        bookingId_authorId: {
          bookingId: dto.bookingId,
          authorId: userId,
        },
      },
    });

    if (existing) {
      throw new BadRequestException(
        'Já submeteste uma avaliação para esta reserva.',
      );
    }

    // 5. Determinar o targetId:
    //    CLIENT avalia equipment (targetId = equipmentId)
    //    OWNER avalia cliente (targetId = clientId)
    const targetId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.equipmentId
        : booking.clientId;

    // 6. Criar a review e actualizar os ratings numa transacção atómica
    const review = await this.prisma.$transaction(async (tx) => {
      // Criar a review
      const created = await tx.review.create({
        data: {
          bookingId: dto.bookingId,
          authorId: userId,
          targetId,
          authorRole: dto.authorRole,
          rating: dto.rating,
          comment: dto.comment,
        },
        include: { author: { select: AUTHOR_SELECT } },
      });

      // Recalcular rating do target
      if (dto.authorRole === ReviewAuthorRole.CLIENT) {
        // Cliente avaliou o equipment — recalcular rating do equipment
        await this.recalculateEquipmentRating(tx, booking.equipmentId);
        // Cliente avaliou também o owner indirectamente — recalcular rating do owner
        await this.recalculateUserRating(tx, booking.ownerId);
      } else {
        // Owner avaliou o cliente — recalcular rating do cliente
        await this.recalculateUserRating(tx, booking.clientId);
      }

      return created;
    });

    return {
      message: 'Avaliação submetida com sucesso.',
      data: ReviewPresenter.toItem(review),
    };
  }

  // ─── Listar avaliações de um equipment ───────────────────────────────────

  async findByEquipment(equipmentId: string, query: FindReviewsQueryDto) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      targetId: equipmentId,
      authorRole: ReviewAuthorRole.CLIENT,
    };

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
      data: items.map(ReviewPresenter.toItem),
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

  // ─── Listar avaliações de um utilizador (como target) ────────────────────

  async findByUser(targetUserId: string, query: FindReviewsQueryDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      targetId: targetUserId,
      ...(query.authorRole ? { authorRole: query.authorRole } : {}),
    };

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
      data: items.map(ReviewPresenter.toItem),
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

  // ─── As minhas avaliações submetidas ─────────────────────────────────────

  async findMyReviews(userId: string, query: FindReviewsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      authorId: userId,
      ...(query.bookingId ? { bookingId: query.bookingId } : {}),
    };

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
      message: 'As tuas avaliações obtidas com sucesso.',
      data: items.map(ReviewPresenter.toItem),
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

  // ─── Verificar se pode avaliar uma booking ────────────────────────────────

  async canReview(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        clientId: true,
        ownerId: true,
        status: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    const isParticipant =
      booking.clientId === userId || booking.ownerId === userId;

    if (!isParticipant) {
      return {
        message: 'Verificação concluída.',
        data: { canReview: false, reason: 'Não és participante desta reserva.' },
      };
    }

    const statusAllowed = REVIEWABLE_STATUSES.includes(booking.status);

    if (!statusAllowed) {
      return {
        message: 'Verificação concluída.',
        data: {
          canReview: false,
          reason: 'A reserva ainda não está concluída ou cancelada.',
        },
      };
    }

    const existing = await this.prisma.review.findUnique({
      where: {
        bookingId_authorId: { bookingId, authorId: userId },
      },
    });

    if (existing) {
      return {
        message: 'Verificação concluída.',
        data: { canReview: false, reason: 'Já avaliaste esta reserva.' },
      };
    }

    const role =
      booking.clientId === userId
        ? ReviewAuthorRole.CLIENT
        : ReviewAuthorRole.OWNER;

    return {
      message: 'Verificação concluída.',
      data: { canReview: true, role },
    };
  }

  // ─── Helpers privados — recálculo de ratings ──────────────────────────────

  private async recalculateEquipmentRating(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    equipmentId: string,
  ) {
    const result = await tx.review.aggregate({
      where: {
        targetId: equipmentId,
        authorRole: ReviewAuthorRole.CLIENT,
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

  private async recalculateUserRating(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    userId: string,
  ) {
    const result = await tx.review.aggregate({
      where: { targetId: userId },
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
