import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  DisputeStatus,
  PaymentStatus,
  Prisma,
  ReviewAuthorRole,
  ServiceBookingStatus,
} from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { CreateReviewDto } from '../dto/create-review.dto';
import { FindReviewsQueryDto } from '../dto/find-reviews-query.dto';
import { ReviewPresenter } from '../presenters/review.presenter';
import { mayReviewAs, Reviewers, whoMayReview } from '../review-eligibility';

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

const ALREADY_REVIEWED = 'Já submeteste uma avaliação para esta reserva.';
const NOTHING_TO_REVIEW =
  'Esta reserva foi cancelada e o valor foi todo devolvido, por isso não há o que avaliar.';

/** O pagamento de uma reserva, no que as regras de avaliação precisam. */
const PAYMENT_OUTCOME_SELECT = {
  id: true,
  heldAt: true,
  status: true,
} as const;

/** Uma reserva concluída ou cancelada, vista por quem a quer avaliar. */
interface FinishedReservation {
  finished: 'completed' | 'cancelled';
  payment: { id: string; heldAt: Date | null; status: PaymentStatus } | null;
  /** Como encontrar um strike dado ao provider por esta reserva. */
  strikeWhere: Prisma.ProviderStrikeWhereInput;
}

/**
 * As linhas cuja nota muda com uma avaliação: o anúncio e o provider quando
 * avalia o cliente, a conta do cliente quando avalia o provider.
 */
interface RatedRows {
  equipmentId?: string;
  serviceId?: string;
  providerId?: string;
  clientId?: string;
}

/** O índice único da base recusou uma segunda avaliação da mesma reserva. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  private async notifyReviewTarget(
    targetUserId: string,
    rating: number,
    reviewId: string,
  ): Promise<void> {
    // O aviso corre depois de a avaliação estar gravada. Se falhar, fica no
    // log e não chega a quem avaliou.
    try {
      const target = await this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { pushToken: true },
      });
      if (!target?.pushToken) return;
      const stars = '⭐'.repeat(Math.min(5, Math.max(1, Math.round(rating))));
      await this.push.send({
        to: target.pushToken,
        title: 'Nova avaliação recebida',
        body: `${stars} ${rating.toFixed(1)} estrelas.`,
        data: { type: 'review_received', reviewId, rating },
      });
    } catch (error) {
      this.logger.warn(
        `Aviso da avaliação ${reviewId} falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
        payment: { select: PAYMENT_OUTCOME_SELECT },
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

    this.assertMoneyWasAtStake(booking.payment);

    this.assertAuthorRole(userId, dto.authorRole, {
      clientId: booking.clientId,
      providerId: booking.ownerId,
    });

    await this.assertSomethingToReview(dto.authorRole, {
      finished:
        booking.status === BookingStatus.COMPLETED ? 'completed' : 'cancelled',
      payment: booking.payment,
      strikeWhere: { bookingId },
    });

    const existing = await this.prisma.review.findFirst({
      where: { bookingId, authorId: userId },
    });

    if (existing) {
      throw new BadRequestException(ALREADY_REVIEWED);
    }

    const targetId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.equipmentId
        : booking.clientId;

    const review = await this.saveReview(
      {
        bookingId,
        authorId: userId,
        targetId,
        authorRole: dto.authorRole,
        rating: dto.rating,
        comment: dto.comment,
      },
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? { equipmentId: booking.equipmentId, providerId: booking.ownerId }
        : { clientId: booking.clientId },
    );

    const targetUserId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.ownerId
        : booking.clientId;
    void this.notifyReviewTarget(targetUserId, dto.rating, review.id);

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
        payment: { select: PAYMENT_OUTCOME_SELECT },
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

    this.assertMoneyWasAtStake(booking.payment);

    this.assertAuthorRole(userId, dto.authorRole, {
      clientId: booking.clientId,
      providerId: booking.providerId,
    });

    await this.assertSomethingToReview(dto.authorRole, {
      finished:
        booking.status === ServiceBookingStatus.COMPLETED
          ? 'completed'
          : 'cancelled',
      payment: booking.payment,
      strikeWhere: { serviceBookingId },
    });

    const existing = await this.prisma.review.findFirst({
      where: { serviceBookingId, authorId: userId },
    });

    if (existing) {
      throw new BadRequestException(ALREADY_REVIEWED);
    }

    const targetId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.serviceId
        : booking.clientId;

    const review = await this.saveReview(
      {
        serviceBookingId,
        authorId: userId,
        targetId,
        authorRole: dto.authorRole,
        rating: dto.rating,
        comment: dto.comment,
      },
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? { serviceId: booking.serviceId, providerId: booking.providerId }
        : { clientId: booking.clientId },
    );

    const targetUserId =
      dto.authorRole === ReviewAuthorRole.CLIENT
        ? booking.providerId
        : booking.clientId;
    void this.notifyReviewTarget(targetUserId, dto.rating, review.id);

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
      this.receivedBy(targetUserId, query.authorRole),
      query,
    );
  }

  /**
   * As avaliações que uma conta recebeu. Como provider, são as que os
   * clientes deixaram aos alugueres e aos serviços dela. Como cliente, são as
   * que os providers lhe deixaram. `authorRole` escolhe um dos lados: CLIENT
   * dá as que vieram de clientes, PROVIDER as que vieram de providers.
   */
  private receivedBy(
    userId: string,
    authorRole?: ReviewAuthorRole,
  ): Prisma.ReviewWhereInput {
    const asProvider = this.receivedAsProvider(userId);
    const asClient = this.receivedAsClient(userId);

    if (authorRole === ReviewAuthorRole.CLIENT) return asProvider;
    if (authorRole === ReviewAuthorRole.PROVIDER) return asClient;
    return { OR: [asProvider, asClient] };
  }

  private receivedAsProvider(userId: string): Prisma.ReviewWhereInput {
    return {
      authorRole: ReviewAuthorRole.CLIENT,
      OR: [
        { booking: { is: { ownerId: userId } } },
        { serviceBooking: { is: { providerId: userId } } },
      ],
    };
  }

  private receivedAsClient(userId: string): Prisma.ReviewWhereInput {
    return { authorRole: ReviewAuthorRole.PROVIDER, targetId: userId };
  }

  /**
   * Grava a avaliação e refaz as notas na mesma transacção. As linhas cuja
   * nota muda são trancadas primeiro: duas avaliações ao mesmo anúncio, ou a
   * anúncios do mesmo provider, fazem as contas uma depois da outra. Sem
   * isso, cada uma agregava sem ver a outra e uma ficava fora da contagem.
   */
  private async saveReview(
    data: Prisma.ReviewUncheckedCreateInput,
    rated: RatedRows,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockRatedRows(tx, rated);

        const created = await tx.review.create({
          data,
          include: { author: { select: AUTHOR_SELECT } },
        });

        if (rated.equipmentId) {
          await this.recalculateEquipmentRating(tx, rated.equipmentId);
        }
        if (rated.serviceId) {
          await this.recalculateServiceRating(tx, rated.serviceId);
        }
        if (rated.providerId) {
          await this.recalculateProviderRating(tx, rated.providerId);
        }
        if (rated.clientId) {
          await this.recalculateClientRating(tx, rated.clientId);
        }

        return created;
      });
    } catch (error) {
      // Dois pedidos da mesma avaliação ao mesmo tempo: o índice único da
      // base deixa passar um só.
      if (isUniqueViolation(error)) {
        throw new BadRequestException(ALREADY_REVIEWED);
      }
      throw error;
    }
  }

  /**
   * Tranca as linhas, sempre pela mesma ordem (o anúncio e depois a conta),
   * para duas avaliações em simultâneo nunca ficarem à espera uma da outra.
   */
  private async lockRatedRows(tx: TxClient, rated: RatedRows) {
    if (rated.equipmentId) {
      await tx.$queryRaw`SELECT 1 FROM "Equipment" WHERE "id" = ${rated.equipmentId} FOR UPDATE`;
    }
    if (rated.serviceId) {
      await tx.$queryRaw`SELECT 1 FROM "Service" WHERE "id" = ${rated.serviceId} FOR UPDATE`;
    }

    const userId = rated.providerId ?? rated.clientId;
    if (userId) {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    }
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
      select: {
        id: true,
        clientId: true,
        ownerId: true,
        status: true,
        payment: { select: PAYMENT_OUTCOME_SELECT },
      },
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
      wasPaid: Boolean(booking.payment?.heldAt),
      reviewers: () =>
        this.reviewersOf({
          finished:
            booking.status === BookingStatus.COMPLETED
              ? 'completed'
              : 'cancelled',
          payment: booking.payment,
          strikeWhere: { bookingId },
        }),
      existingReviewWhere: { bookingId, authorId: userId },
    });
  }

  async canReviewServiceBooking(userId: string, serviceBookingId: string) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      select: {
        id: true,
        clientId: true,
        providerId: true,
        status: true,
        payment: { select: PAYMENT_OUTCOME_SELECT },
      },
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
      wasPaid: Boolean(booking.payment?.heldAt),
      reviewers: () =>
        this.reviewersOf({
          finished:
            booking.status === ServiceBookingStatus.COMPLETED
              ? 'completed'
              : 'cancelled',
          payment: booking.payment,
          strikeWhere: { serviceBookingId },
        }),
      existingReviewWhere: { serviceBookingId, authorId: userId },
    });
  }

  /**
   * Só se avalia uma reserva que chegou a ter dinheiro no escrow. Sem isso,
   * bastava reservar e cancelar para deixar uma avaliação a alguém com quem
   * nunca se fez negócio.
   */
  private assertMoneyWasAtStake(payment: { heldAt: Date | null } | null) {
    if (!payment?.heldAt) {
      throw new BadRequestException(
        'Só é possível avaliar uma reserva que chegou a ser paga.',
      );
    }
  }

  /**
   * Quem pode avaliar esta reserva (ver `whoMayReview`). Só pergunta se o
   * provider falhou quando isso muda a resposta: num cancelamento com o
   * dinheiro todo devolvido.
   */
  private async reviewersOf(
    reservation: FinishedReservation,
  ): Promise<Reviewers> {
    const { finished, payment } = reservation;
    const providerAtFault =
      finished === 'cancelled' && payment?.status === PaymentStatus.REFUNDED
        ? await this.providerFailed(payment.id, reservation.strikeWhere)
        : false;

    return whoMayReview({ finished, payment, providerAtFault });
  }

  /** O provider levou strike por esta reserva ou perdeu a disputa por inteiro. */
  private async providerFailed(
    paymentId: string,
    strikeWhere: Prisma.ProviderStrikeWhereInput,
  ): Promise<boolean> {
    const [strike, lostDispute] = await Promise.all([
      this.prisma.providerStrike.findFirst({
        where: strikeWhere,
        select: { id: true },
      }),
      this.prisma.dispute.findFirst({
        where: { paymentId, status: DisputeStatus.RESOLVED_CLIENT },
        select: { id: true },
      }),
    ]);

    return Boolean(strike ?? lostDispute);
  }

  private async assertSomethingToReview(
    role: ReviewAuthorRole,
    reservation: FinishedReservation,
  ) {
    if (!mayReviewAs(await this.reviewersOf(reservation), role)) {
      throw new BadRequestException(NOTHING_TO_REVIEW);
    }
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
    /** O dinheiro chegou a entrar no escrow. */
    wasPaid: boolean;
    /** Quem pode avaliar, pelo que aconteceu à reserva e ao dinheiro. */
    reviewers: () => Promise<Reviewers>;
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

    if (!params.wasPaid) {
      return {
        message: 'Verificação concluída.',
        data: {
          canReview: false,
          reason: 'A reserva não chegou a ser paga.',
        },
      };
    }

    const role =
      params.participants.clientId === params.userId
        ? ReviewAuthorRole.CLIENT
        : ReviewAuthorRole.PROVIDER;

    if (!mayReviewAs(await params.reviewers(), role)) {
      return {
        message: 'Verificação concluída.',
        data: { canReview: false, reason: NOTHING_TO_REVIEW },
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
        totalRating: result._avg?.rating ?? null,
        totalReviews: result._count?.rating ?? 0,
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
        totalRating: result._avg?.rating ?? null,
        totalReviews: result._count?.rating ?? 0,
      },
    });
  }

  /**
   * A nota de uma conta como provider: o que os clientes disseram dos
   * alugueres e dos serviços que ela forneceu. É a que aparece ao lado dos
   * anúncios dela.
   */
  private async recalculateProviderRating(tx: TxClient, userId: string) {
    const result = await tx.review.aggregate({
      where: this.receivedAsProvider(userId),
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        providerRating: result._avg?.rating ?? null,
        providerReviews: result._count?.rating ?? 0,
      },
    });
  }

  /**
   * A nota de uma conta como cliente: o que os providers disseram dela.
   * Fica à parte, para um mau aluguer como cliente não baixar a nota dos
   * anúncios de quem também é provider.
   */
  private async recalculateClientRating(tx: TxClient, userId: string) {
    const result = await tx.review.aggregate({
      where: this.receivedAsClient(userId),
      _avg: { rating: true },
      _count: { rating: true },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        clientRating: result._avg?.rating ?? null,
        clientReviews: result._count?.rating ?? 0,
      },
    });
  }
}
