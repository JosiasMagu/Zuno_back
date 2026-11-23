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
  Equipment,
  EquipmentStatus,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
  Prisma,
  UserRole,
} from '@prisma/client';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { calculatePlatformFee } from '../../../shared/constants/fees';
import {
  BOOKING_MAX_DAYS,
  UNPAID_BOOKINGS_PER_CLIENT,
  UNPAID_DAYS_PER_LISTING,
  CANCELLATION_FREE_WINDOW_HOURS,
  DEPOSIT_CLAIM_WINDOW_HOURS,
  LATE_CANCELLATION_RETENTION_PERCENT,
  percentOf,
  roundMoney,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { OPEN_DISPUTES } from '../../../shared/disputes/open-disputes';
import { carriesOnWork } from '../../../shared/moderation/listing-moderation';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { PushService } from '../../../shared/push/push.service';
import {
  describeError,
  processDue,
} from '../../../shared/scheduling/process-due';
import { issueProviderStrike } from '../../../shared/strikes/provider-strikes';
import { EscrowRefundService } from '../../payments/services/escrow-refund.service';
import { RENTAL_PAID_OUT_STATUSES } from '../../payments/payment-states';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';
import { expiryReason } from '../../payments/unpaid-reservation';
import { paymentDeadline } from '../booking-deadlines';
import {
  COMMITTED_STATUSES,
  OCCUPANCY_SELECT,
  occupyingDuring,
  peakOccupancyDuring,
  RESERVING_STATUSES,
  startOfDay,
} from '../booking-occupancy';
import type { OccupancyPeriod } from '../booking-occupancy';
import { CreateBookingDto } from '../dto/create-booking.dto';
import { FindBookingsQueryDto } from '../dto/find-bookings-query.dto';
import { UpdateBookingStatusDto } from '../dto/update-booking-status.dto';
import { BookingPresenter } from '../presenters/booking.presenter';

const BOOKING_CHANGED =
  'A reserva mudou de estado enquanto o pedido era tratado. Actualiza e tenta de novo.';

/** Quantas reservas cada job trata de cada vez. */
const JOB_BATCH_SIZE = 50;

const BOOKING_FOR_CANCELLATION_INCLUDE = {
  equipment: {
    select: {
      id: true,
      title: true,
      location: true,
      status: true,
    },
  },
  client: {
    select: { id: true, name: true, avatarUrl: true, pushToken: true },
  },
  owner: {
    select: { id: true, name: true, avatarUrl: true, pushToken: true },
  },
  payment: { select: { id: true, status: true } },
} satisfies Prisma.BookingInclude;

type BookingForCancellation = Prisma.BookingGetPayload<{
  include: typeof BOOKING_FOR_CANCELLATION_INCLUDE;
}>;

const BOOKING_FOR_RETURN_INCLUDE = {
  equipment: {
    select: { id: true, title: true },
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
} satisfies Prisma.BookingInclude;

/** Período de uma reserva, em dias inteiros: começa em `startDate` e acaba em `endDate`. */
interface BookingPeriod {
  startDate: Date;
  endDate: Date;
  totalDays: number;
}

interface BookingPrice {
  rentalAmount: number;
  depositAmount: number;
  platformFee: number;
  /** O que o cliente paga: aluguer, depósito e taxa. */
  totalAmount: number;
}

/** Uma reserva validada e com preço, pronta a inserir se houver unidade livre. */
interface NewBooking extends BookingPeriod, BookingPrice {
  clientId: string;
  equipment: Pick<Equipment, 'id' | 'ownerId'>;
  deliveryAddress: string | null;
  clientNote: string | null;
}

/** O que a confirmação precisa de saber da reserva dentro da transacção. */
interface BookingToConfirm {
  id: string;
  equipmentId: string;
  startDate: Date;
  endDate: Date;
}

/** O que se sabe sobre um cancelamento antes de o aplicar na transacção. */
interface BookingCancellation {
  actorId: string;
  reason: string | null;
  cancelledByClient: boolean;
  /** O cliente cancela a menos de CANCELLATION_FREE_WINDOW_HOURS do início. */
  isLateClientCancellation: boolean;
  /** O provider cancela uma reserva que ele próprio já tinha confirmado. */
  issuesProviderStrike: boolean;
}

/** Pagamento retido de uma reserva cancelada, com o que é preciso para o devolver. */
interface CancelledPayment {
  id: string;
  totalCharged: Prisma.Decimal;
  rentalAmount: Prisma.Decimal;
  depositStatus: DepositStatus;
  clientId: string;
  ownerId: string;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
    private readonly escrowRefunds: EscrowRefundService,
  ) {}

  async create(clientId: string, dto: CreateBookingDto) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: dto.equipmentId.trim() },
      include: { owner: { select: { pushToken: true, isActive: true } } },
    });

    this.assertBookable(equipment, clientId);

    // O catálogo já esconde os anúncios de uma conta suspensa. Quem guardou
    // o link também não reserva.
    if (!equipment.owner.isActive) {
      throw new BadRequestException(
        'Este equipamento não está disponível para reserva.',
      );
    }

    const period = this.resolveBookingPeriod(dto.startDate, dto.endDate);
    const price = this.priceBooking(equipment, period.totalDays);

    const booking = await this.runSerializable(
      (tx) =>
        this.insertIfUnitFree(tx, {
          clientId,
          equipment,
          ...period,
          ...price,
          deliveryAddress: dto.deliveryAddress?.trim() || null,
          clientNote: dto.clientNote?.trim() || null,
        }),
      'Já existe uma reserva para este equipamento nesse período.',
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
            depositStatus: true,
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

    this.assertConfirmable(booking.status);
    this.assertEquipmentIsActive(booking.equipment);

    const updatedBooking = await this.runSerializable(
      (tx) => this.applyConfirmation(tx, booking),
      'Outra confirmação está em curso para este equipamento. Tenta novamente.',
    );

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
      include: BOOKING_FOR_CANCELLATION_INCLUDE,
    });

    if (!booking) throw new NotFoundException('Reserva não encontrada.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const isAdmin = user.role === UserRole.ADMIN;
    const cancelledByClient = booking.clientId === userId;
    const cancelledByProvider = booking.ownerId === userId;

    if (!isAdmin && !cancelledByClient && !cancelledByProvider) {
      throw new ForbiddenException(
        'Não tens permissão para cancelar esta reserva.',
      );
    }

    this.assertCancellable(booking.status);

    const wasConfirmed = booking.status === BookingStatus.CONFIRMED;
    const cancellation: BookingCancellation = {
      actorId: userId,
      reason: dto.reason?.trim() || null,
      cancelledByClient,
      isLateClientCancellation:
        cancelledByClient &&
        this.hoursUntil(booking.startDate) < CANCELLATION_FREE_WINDOW_HOURS,
      issuesProviderStrike: cancelledByProvider && wasConfirmed && !isAdmin,
    };

    const { cancelled: updatedBooking, suspendedUntil } =
      await this.runSerializable(
        (tx) => this.applyCancellation(tx, booking, cancellation),
        BOOKING_CHANGED,
        8000,
      );

    if (cancellation.issuesProviderStrike) {
      await this.audit.record({
        action: AuditAction.PROVIDER_STRIKE_ISSUED,
        actorId: userId,
        targetType: 'User',
        targetId: booking.ownerId,
        metadata: { bookingId: booking.id },
      });
    }

    if (suspendedUntil) {
      await this.audit.record({
        action: AuditAction.PROVIDER_LISTINGS_SUSPENDED,
        actorId: SYSTEM_ACTOR_ID,
        targetType: 'User',
        targetId: booking.ownerId,
        metadata: {
          bookingId: booking.id,
          suspendedUntil: suspendedUntil.toISOString(),
        },
      });
    }

    this.notifyCancellation(booking, cancelledByClient);

    return {
      message: 'Reserva cancelada com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  /**
   * Segundo checkpoint do escrow: o provider confirma a devolução do
   * equipamento em boas condições, a reserva conclui e o depósito volta ao
   * cliente. Para reclamar o depósito por dano, o provider abre uma disputa
   * de depósito antes de confirmar a devolução (POST /disputes/deposit-claim).
   */
  async complete(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: BOOKING_FOR_RETURN_INCLUDE,
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

    this.assertReturnable(booking.status);

    const updatedBooking = await this.runSerializable(
      (tx) => this.applyReturn(tx, booking, userId),
      BOOKING_CHANGED,
      8000,
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

    this.notifyRentalCompleted(booking);

    return {
      message: 'Devolução confirmada e reserva concluída com sucesso.',
      data: BookingPresenter.toListItem(updatedBooking),
    };
  }

  /**
   * Auto-devolução do depósito: reservas entregues cuja janela de reclamação
   * já fechou sem o provider confirmar a devolução nem reclamar. Chamado pelo
   * BookingsScheduler.
   */
  async autoReturnDepositsDue(): Promise<number> {
    // A janela conta do fim do aluguer ou da entrega, o que for mais tarde
    // (ver depositClaimDeadline). Está fechada quando os dois já ficaram a
    // mais de DEPOSIT_CLAIM_WINDOW_HOURS de distância.
    const windowClosedBefore = new Date();
    windowClosedBefore.setHours(
      windowClosedBefore.getHours() - DEPOSIT_CLAIM_WINDOW_HOURS,
    );

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.booking.findMany({
          where: {
            id: { notIn: seenIds },
            status: BookingStatus.ACTIVE,
            endDate: { lte: windowClosedBefore },
            OR: [
              { deliveryConfirmedAt: null },
              { deliveryConfirmedAt: { lte: windowClosedBefore } },
            ],
            disputes: { none: OPEN_DISPUTES },
            payment: { status: { in: RENTAL_PAID_OUT_STATUSES } },
          },
          select: { id: true },
          orderBy: { endDate: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (booking) => this.returnDepositAutomatically(booking.id),
      onFailure: (booking, error) =>
        this.logger.warn(
          `Auto-devolução falhou para a reserva ${booking.id}: ${describeError(error)}`,
        ),
    });
  }

  /**
   * Expira as reservas cujo prazo de pagamento passou sem o dinheiro entrar.
   * Deixam de ocupar as datas do equipamento. Chamado pelo BookingsScheduler.
   */
  async expireUnpaidBookings(): Promise<number> {
    const now = new Date();

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.booking.findMany({
          where: { id: { notIn: seenIds }, ...this.unpaidPastDeadline(now) },
          select: { id: true },
          orderBy: { expiresAt: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (booking) => this.expireBooking(booking.id, now),
      onFailure: (booking, error) =>
        this.logger.warn(
          `Expiração falhou para a reserva ${booking.id}: ${describeError(error)}`,
        ),
    });
  }

  /**
   * O sistema dá a reserva por concluída e devolve o depósito, sem ninguém a
   * pedir. Fica em auditoria como acção do sistema, e não do provider.
   */
  private async returnDepositAutomatically(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: BOOKING_FOR_RETURN_INCLUDE,
    });

    // Se alguém mexeu na reserva ao mesmo tempo, fica para a hora seguinte.
    await this.runSerializable(
      (tx) => this.applyReturn(tx, booking, null),
      BOOKING_CHANGED,
      8000,
    );

    await this.audit.record({
      action: AuditAction.DEPOSIT_AUTO_RETURNED,
      actorId: SYSTEM_ACTOR_ID,
      targetType: 'Booking',
      targetId: booking.id,
      metadata: { reason: 'deposit_claim_window_expired' },
    });

    this.notifyRentalCompleted(booking);
  }

  /** Reservas vivas com o prazo de pagamento vencido e sem dinheiro no escrow. */
  private unpaidPastDeadline(now: Date): Prisma.BookingWhereInput {
    return {
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      expiresAt: { lte: now },
      OR: [
        { payment: null },
        {
          payment: {
            status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
          },
        },
      ],
    };
  }

  private async expireBooking(bookingId: string, now: Date): Promise<void> {
    const expired = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { bookingId },
        select: { declaredAt: true, declaredReference: true },
      });

      // O filtro repete-se na escrita. Se o pagamento entrou entretanto, a
      // reserva já não tem prazo e deixa de ser apanhada.
      const { count } = await tx.booking.updateMany({
        where: { id: bookingId, ...this.unpaidPastDeadline(now) },
        data: {
          status: BookingStatus.EXPIRED,
          cancelledAt: now,
          cancellationReason: expiryReason(payment),
        },
      });

      if (count === 0) {
        return null;
      }

      await tx.payment.updateMany({
        where: { bookingId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });

      return { declaredReference: payment?.declaredReference ?? null };
    });

    if (!expired) {
      return;
    }

    await this.audit.record({
      action: AuditAction.BOOKING_EXPIRED,
      actorId: SYSTEM_ACTOR_ID,
      targetType: 'Booking',
      targetId: bookingId,
      // Com pagamento declarado, a referência fica aqui para o admin
      // reconciliar com o extracto e devolver o dinheiro, se tiver entrado.
      metadata: { declaredReference: expired.declaredReference },
    });

    await this.notifyBookingExpired(
      bookingId,
      expired.declaredReference !== null,
    );
  }

  private async notifyBookingExpired(
    bookingId: string,
    paymentWasDeclared: boolean,
  ): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        client: { select: { pushToken: true } },
        equipment: { select: { title: true } },
      },
    });

    if (!booking?.client.pushToken) {
      return;
    }

    const { title } = booking.equipment;

    this.push
      .send({
        to: booking.client.pushToken,
        title: 'Reserva expirada',
        body: paymentWasDeclared
          ? `Não foi possível confirmar o pagamento de "${title}" e a reserva expirou. Se pagaste, contacta o suporte com a referência M-Pesa.`
          : `A tua reserva de "${title}" expirou porque o pagamento não foi feito a tempo.`,
        data: { type: 'booking', bookingId },
      })
      .catch(() => {});
  }

  /** Avisa o cliente de que o aluguer acabou e o depósito vai ser devolvido. */
  private notifyRentalCompleted(booking: {
    id: string;
    client: { pushToken: string | null };
    equipment: { title: string };
  }) {
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
  }

  /**
   * Corre `work` numa transacção serializável. Se o Postgres a abortar por
   * conflito com outra transacção em simultâneo (P2034), quem perdeu a
   * corrida recebe `conflictMessage` como 400, em vez de um erro 500.
   */
  private runSerializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    conflictMessage: string,
    timeoutMs?: number,
  ): Promise<T> {
    return runSerializable(
      this.prisma,
      work,
      () => new BadRequestException(conflictMessage),
      timeoutMs,
    );
  }

  private assertBookable<
    T extends Pick<Equipment, 'status' | 'isAvailable' | 'ownerId'>,
  >(equipment: T | null, clientId: string): asserts equipment is T {
    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    if (equipment.status !== EquipmentStatus.ACTIVE) {
      throw new BadRequestException(
        'Este equipamento não está disponível para reserva.',
      );
    }

    // Pausado pelo provider ou suspenso por strikes. Se há unidade livre
    // decide-se depois, pelas datas pedidas.
    if (!equipment.isAvailable) {
      throw new BadRequestException(
        'Este equipamento não está a aceitar reservas.',
      );
    }

    if (equipment.ownerId === clientId) {
      throw new BadRequestException(
        'Não podes reservar o teu próprio equipamento.',
      );
    }
  }

  /**
   * Converte as datas pedidas em dias inteiros e valida o período: não pode
   * começar no passado, tem de durar pelo menos um dia e não pode passar da
   * duração máxima.
   */
  private resolveBookingPeriod(start: string, end: string): BookingPeriod {
    const requestedStart = new Date(start);
    const requestedEnd = new Date(end);

    if (
      Number.isNaN(requestedStart.getTime()) ||
      Number.isNaN(requestedEnd.getTime())
    ) {
      throw new BadRequestException('Datas inválidas.');
    }

    const startDate = startOfDay(requestedStart);
    const endDate = startOfDay(requestedEnd);

    if (startDate < startOfDay(new Date())) {
      throw new BadRequestException('A data inicial não pode ser no passado.');
    }

    if (endDate <= startDate) {
      throw new BadRequestException(
        'A data final deve ser maior que a data inicial.',
      );
    }

    const totalDays = this.calculateTotalDays(startDate, endDate);
    if (totalDays < 1) {
      throw new BadRequestException('A reserva deve ter pelo menos 1 dia.');
    }

    if (totalDays > BOOKING_MAX_DAYS) {
      throw new BadRequestException(
        `Uma reserva não pode ter mais de ${BOOKING_MAX_DAYS} dias.`,
      );
    }

    return { startDate, endDate, totalDays };
  }

  /** O preço é calculado no servidor: aluguer pelos dias, mais depósito e taxa. */
  private priceBooking(
    equipment: Pick<Equipment, 'pricePerDay' | 'depositAmount'>,
    totalDays: number,
  ): BookingPrice {
    // Em decimal, como o resto do dinheiro: em vírgula flutuante, 0.1 vezes 3
    // dá 0.30000000000000004 e o total deixava de ser a soma das partes.
    const rentalAmount = roundMoney(
      new Prisma.Decimal(equipment.pricePerDay).mul(totalDays).toNumber(),
    );
    const depositAmount = roundMoney(Number(equipment.depositAmount ?? 0));
    const platformFee = this.calculatePlatformFee(rentalAmount);

    return {
      rentalAmount,
      depositAmount,
      platformFee,
      totalAmount: roundMoney(
        new Prisma.Decimal(rentalAmount)
          .plus(depositAmount)
          .plus(platformFee)
          .toNumber(),
      ),
    };
  }

  /**
   * Só insere a reserva se ainda houver uma unidade livre no período. Corre
   * numa transacção serializável, para que dois pedidos em simultâneo não
   * fiquem com a mesma unidade, e relê o anúncio, que pode ter sido pausado
   * ou reduzido desde a leitura de fora.
   */
  private async insertIfUnitFree(
    tx: Prisma.TransactionClient,
    booking: NewBooking,
  ) {
    const { equipment } = booking;

    const current = await tx.equipment.findUnique({
      where: { id: equipment.id },
      select: { quantity: true, status: true, isAvailable: true },
    });
    if (current?.status !== EquipmentStatus.ACTIVE || !current.isAvailable) {
      throw ApiErrors.badRequest(
        ErrorCode.EQUIPMENT_NOT_AVAILABLE,
        'Este equipamento não está disponível para reserva.',
      );
    }

    await this.assertUnpaidBookingsWithinLimit(tx, booking);

    const unitsTaken = await this.unitsTakenDuring(tx, {
      equipmentId: equipment.id,
      period: booking,
      statuses: RESERVING_STATUSES,
    });
    if (unitsTaken >= current.quantity) {
      throw ApiErrors.badRequest(
        ErrorCode.BOOKING_OVERLAP,
        'Não há unidades disponíveis para este equipamento nesse período.',
      );
    }

    return tx.booking.create({
      data: {
        clientId: booking.clientId,
        equipmentId: equipment.id,
        ownerId: equipment.ownerId,
        startDate: booking.startDate,
        endDate: booking.endDate,
        totalDays: booking.totalDays,
        rentalAmount: booking.rentalAmount,
        depositAmount: booking.depositAmount,
        platformFee: booking.platformFee,
        totalAmount: booking.totalAmount,
        deliveryAddress: booking.deliveryAddress,
        clientNote: booking.clientNote,
        status: BookingStatus.PENDING,
        expiresAt: paymentDeadline(new Date(), booking.startDate),
      },
      include: {
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        equipment: {
          select: { id: true, title: true, location: true, status: true },
        },
      },
    });
  }

  /**
   * Unidades do equipamento ocupadas ao mesmo tempo dentro do período, pelas
   * reservas nestes estados. É o pico, e não o número de reservas: duas que
   * nunca coincidem ocupam uma unidade só.
   */
  private async unitsTakenDuring(
    tx: Prisma.TransactionClient,
    query: {
      equipmentId: string;
      period: OccupancyPeriod;
      statuses: BookingStatus[];
      exceptBookingId?: string;
    },
  ): Promise<number> {
    const occupying = await tx.booking.findMany({
      where: {
        equipmentId: query.equipmentId,
        ...(query.exceptBookingId
          ? { id: { not: query.exceptBookingId } }
          : {}),
        ...occupyingDuring(query.period, query.statuses),
      },
      select: OCCUPANCY_SELECT,
    });

    return peakOccupancyDuring(occupying, query.period);
  }

  /**
   * Uma reserva por pagar ocupa as datas sem custo para quem a faz. Os tectos
   * impedem uma conta de fechar o calendário de outra. Conta como por pagar
   * a que ainda tem prazo de pagamento a correr.
   */
  private async assertUnpaidBookingsWithinLimit(
    tx: Prisma.TransactionClient,
    booking: Pick<NewBooking, 'clientId' | 'equipment' | 'totalDays'>,
  ) {
    const unpaid = await tx.booking.findMany({
      where: {
        clientId: booking.clientId,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
        expiresAt: { not: null },
      },
      select: { equipmentId: true, totalDays: true },
    });
    const unpaidDaysHere = unpaid
      .filter(({ equipmentId }) => equipmentId === booking.equipment.id)
      .reduce((days, { totalDays }) => days + totalDays, 0);

    if (unpaidDaysHere + booking.totalDays > UNPAID_DAYS_PER_LISTING) {
      throw ApiErrors.badRequest(
        ErrorCode.BOOKING_TOO_MANY_UNPAID,
        `Já tens ${unpaidDaysHere} dias reservados e por pagar neste equipamento. Paga ou cancela antes de reservares mais.`,
      );
    }
    if (unpaid.length >= UNPAID_BOOKINGS_PER_CLIENT) {
      throw ApiErrors.badRequest(
        ErrorCode.BOOKING_TOO_MANY_UNPAID,
        `Tens ${unpaid.length} reservas por pagar. Paga ou cancela alguma antes de fazeres outra.`,
      );
    }
  }

  private assertConfirmable(status: BookingStatus | undefined) {
    if (status !== BookingStatus.PENDING) {
      throw new BadRequestException(
        'Apenas reservas pendentes podem ser confirmadas.',
      );
    }
  }

  /**
   * Uma reserva só nasce num anúncio activo. Se entretanto ele voltou à
   * revisão por ter sido editado, a reserva que já existia segue em frente.
   * Rejeitado ou removido, já não se confirma.
   */
  private assertEquipmentIsActive<T extends { status: EquipmentStatus }>(
    equipment: T | null,
  ): asserts equipment is T {
    if (!equipment || !carriesOnWork(equipment.status)) {
      throw new BadRequestException(
        'Não é possível confirmar uma reserva de equipamento inativo.',
      );
    }
  }

  /**
   * Relê a reserva e o equipamento, confirma que há uma unidade livre para
   * as datas pedidas e marca a reserva como CONFIRMED. A partir daí é a
   * própria reserva que ocupa a unidade nessas datas.
   */
  private async applyConfirmation(
    tx: Prisma.TransactionClient,
    booking: BookingToConfirm,
  ) {
    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { status: true },
    });
    this.assertConfirmable(freshBooking?.status);

    const freshEquipment = await tx.equipment.findUnique({
      where: { id: booking.equipmentId },
      select: { quantity: true, status: true },
    });
    this.assertEquipmentIsActive(freshEquipment);

    const committedUnits = await this.unitsTakenDuring(tx, {
      equipmentId: booking.equipmentId,
      period: booking,
      statuses: COMMITTED_STATUSES,
      exceptBookingId: booking.id,
    });
    if (committedUnits >= freshEquipment.quantity) {
      throw ApiErrors.badRequest(
        ErrorCode.BOOKING_OVERLAP,
        'Todas as unidades já estão reservadas para este período.',
      );
    }

    const now = new Date();

    return tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CONFIRMED,
        confirmedAt: now,
        // O cliente só pode pagar depois da confirmação, por isso o prazo de
        // pagamento volta a contar daqui. Até agora era o prazo do provider
        // para responder.
        expiresAt: paymentDeadline(now, booking.startDate),
      },
      include: {
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        equipment: {
          select: { id: true, title: true, location: true, status: true },
        },
      },
    });
  }

  private assertReturnable(status: BookingStatus | undefined) {
    if (status !== BookingStatus.ACTIVE) {
      throw new BadRequestException(
        'Apenas reservas ativas (entrega confirmada) podem ser concluídas.',
      );
    }
  }

  /**
   * Conclui a reserva dentro da transacção: relê o estado e, se o depósito
   * ainda estiver retido, devolve-o ao cliente. `actorId` é null quando é o
   * sistema a concluir.
   */
  private async applyReturn(
    tx: Prisma.TransactionClient,
    booking: {
      id: string;
      equipmentId: string;
      payment: { id: string } | null;
    },
    actorId: string | null,
  ) {
    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { status: true },
    });
    this.assertReturnable(freshBooking?.status);

    const completed = await tx.booking.update({
      where: { id: booking.id },
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

    if (booking.payment) {
      await this.returnHeldDeposit(tx, booking.payment.id, actorId);
    }

    return completed;
  }

  /**
   * Com a devolução do equipamento confirmada, o depósito que ficou retido
   * no release volta ao cliente. Sem depósito retido, não faz nada.
   */
  private async returnHeldDeposit(
    tx: Prisma.TransactionClient,
    paymentId: string,
    actorId: string | null,
  ) {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        depositStatus: true,
        depositAmount: true,
        clientId: true,
      },
    });

    if (
      !payment ||
      !RENTAL_PAID_OUT_STATUSES.includes(payment.status) ||
      payment.depositStatus !== DepositStatus.HELD
    ) {
      return;
    }

    const depositAmount = roundMoney(Number(payment.depositAmount));

    await this.ledger.record(tx, {
      paymentId: payment.id,
      direction: LedgerDirection.OUTFLOW,
      party: LedgerParty.CLIENT,
      amount: depositAmount,
      reason: 'Depósito devolvido ao cliente após devolução confirmada.',
      actorId,
    });

    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.clientId,
      kind: PayoutKind.DEPOSIT_RETURN,
      amount: depositAmount,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        depositStatus: DepositStatus.RETURNED,
        depositReleasedAt: new Date(),
      },
    });
  }

  private assertCancellable(status: BookingStatus | undefined) {
    if (
      status !== BookingStatus.PENDING &&
      status !== BookingStatus.CONFIRMED
    ) {
      throw new BadRequestException(
        'Apenas reservas pendentes ou confirmadas podem ser canceladas.',
      );
    }
  }

  /**
   * Cancela a reserva dentro da transacção: relê o estado, liquida o
   * pagamento e, se for o caso, regista o strike. As datas ficam livres
   * porque uma reserva cancelada deixa de contar como ocupação.
   */
  private async applyCancellation(
    tx: Prisma.TransactionClient,
    booking: BookingForCancellation,
    cancellation: BookingCancellation,
  ) {
    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { status: true },
    });
    this.assertCancellable(freshBooking?.status);
    await this.assertClientMayStillCancel(tx, booking, cancellation);

    const cancelled = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: cancellation.reason,
      },
      include: {
        client: { select: { id: true, name: true, avatarUrl: true } },
        owner: { select: { id: true, name: true, avatarUrl: true } },
        equipment: {
          select: { id: true, title: true, location: true, status: true },
        },
      },
    });

    if (booking.payment) {
      await this.settleCancelledPayment(tx, booking.payment.id, cancellation);
    }

    const suspendedUntil = cancellation.issuesProviderStrike
      ? await issueProviderStrike(tx, {
          providerId: booking.ownerId,
          bookingId: booking.id,
          reason: 'Cancelamento de reserva confirmada.',
        })
      : null;

    return { cancelled, suspendedUntil };
  }

  /**
   * Com o aluguer começado e o dinheiro retido, o cliente pode já ter o
   * equipamento consigo. Deixa de poder cancelar: confirma a entrega ou abre
   * uma disputa. Sem dinheiro retido não há nada a proteger, e o cancelamento
   * continua a servir para fechar uma reserva que ficou por pagar.
   */
  private async assertClientMayStillCancel(
    tx: Prisma.TransactionClient,
    booking: BookingForCancellation,
    cancellation: BookingCancellation,
  ) {
    const rentalHasStarted = this.hoursUntil(booking.startDate) <= 0;

    if (
      !cancellation.cancelledByClient ||
      !rentalHasStarted ||
      !booking.payment
    ) {
      return;
    }

    const payment = await tx.payment.findUnique({
      where: { id: booking.payment.id },
      select: { status: true },
    });

    if (payment?.status === PaymentStatus.HELD) {
      throw ApiErrors.badRequest(
        ErrorCode.BOOKING_RENTAL_STARTED,
        'O aluguer já começou e a reserva já não pode ser cancelada. Se houve um problema com a entrega, abre uma disputa.',
      );
    }
  }

  /**
   * Um pagamento que ainda não entrou no escrow fica FAILED. Um pagamento
   * retido é devolvido: por inteiro, ou com retenção se o cliente cancelou
   * dentro da janela em que o cancelamento já não é gratuito.
   */
  private async settleCancelledPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
    cancellation: BookingCancellation,
  ) {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
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

    if (payment?.status === PaymentStatus.PENDING) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      return;
    }

    if (payment?.status !== PaymentStatus.HELD) return;

    if (cancellation.isLateClientCancellation) {
      await this.refundWithLateRetention(tx, payment, cancellation.actorId);
    } else {
      // Sem penalização (cliente dentro da janela gratuita, provider ou
      // admin), tudo volta ao cliente, incluindo a taxa da plataforma.
      await this.escrowRefunds.refundInFull(tx, payment, {
        actorId: cancellation.actorId,
        reason: 'Reembolso total por cancelamento da reserva.',
      });
    }
  }

  /**
   * Cancelamento tardio do cliente: parte do rental compensa o provider, a
   * plataforma cobra a taxa sobre essa parte, e o resto (incluindo o depósito
   * e a taxa original) volta ao cliente.
   */
  private async refundWithLateRetention(
    tx: Prisma.TransactionClient,
    payment: CancelledPayment,
    actorId: string,
  ) {
    const { clientRefund, providerCompensation, platformCut } =
      this.splitLateCancellation(payment);

    await this.ledger.recordMany(tx, [
      {
        paymentId: payment.id,
        direction: LedgerDirection.OUTFLOW,
        party: LedgerParty.CLIENT,
        amount: clientRefund,
        reason: `Reembolso de cancelamento tardio (retenção de ${LATE_CANCELLATION_RETENTION_PERCENT}% do rental).`,
        actorId,
      },
      {
        paymentId: payment.id,
        direction: LedgerDirection.OUTFLOW,
        party: LedgerParty.PROVIDER,
        amount: providerCompensation,
        reason: 'Compensação ao provider por cancelamento tardio do cliente.',
        actorId,
      },
      {
        paymentId: payment.id,
        direction: LedgerDirection.OUTFLOW,
        party: LedgerParty.PLATFORM,
        amount: platformCut,
        reason: 'Platform fee sobre a retenção de cancelamento tardio.',
        actorId,
      },
    ]);

    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.clientId,
      kind: PayoutKind.CLIENT_REFUND,
      amount: clientRefund,
    });
    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.ownerId,
      kind: PayoutKind.PROVIDER_PAYOUT,
      amount: providerCompensation,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        refundedAt: new Date(),
        refundAmount: clientRefund,
        ownerPayout: providerCompensation,
        ...this.depositReturnedIfHeld(payment.depositStatus),
      },
    });
  }

  /** Como se reparte o que foi cobrado quando o cliente cancela tarde. */
  private splitLateCancellation(payment: CancelledPayment) {
    const retained = percentOf(
      Number(payment.rentalAmount),
      LATE_CANCELLATION_RETENTION_PERCENT,
    );
    const platformCut = calculatePlatformFee(retained);

    return {
      clientRefund: roundMoney(Number(payment.totalCharged) - retained),
      providerCompensation: roundMoney(retained - platformCut),
      platformCut,
    };
  }

  private depositReturnedIfHeld(depositStatus: DepositStatus) {
    return depositStatus === DepositStatus.HELD
      ? { depositStatus: DepositStatus.RETURNED, depositReleasedAt: new Date() }
      : {};
  }

  /** Avisa a outra parte: o provider se cancelou o cliente, o cliente nos outros casos. */
  private notifyCancellation(
    booking: BookingForCancellation,
    cancelledByClient: boolean,
  ) {
    const recipient = cancelledByClient ? booking.owner : booking.client;
    if (!recipient.pushToken) return;

    const body = cancelledByClient
      ? `${booking.client.name} cancelou a reserva de "${booking.equipment.title}"`
      : `${booking.owner.name} cancelou a tua reserva de "${booking.equipment.title}"`;

    this.push
      .send({
        to: recipient.pushToken,
        title: '❌ Reserva cancelada',
        body,
        data: { type: 'booking', bookingId: booking.id },
      })
      .catch(() => {});
  }

  private hoursUntil(date: Date): number {
    return (date.getTime() - Date.now()) / (1000 * 60 * 60);
  }

  private calculateTotalDays(startDate: Date, endDate: Date): number {
    const diffMs = endDate.getTime() - startDate.getTime();
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  private calculatePlatformFee(rentalAmount: number): number {
    return calculatePlatformFee(rentalAmount);
  }
}
