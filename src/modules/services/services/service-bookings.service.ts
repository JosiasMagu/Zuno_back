import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import {
  describeError,
  processDue,
} from '../../../shared/scheduling/process-due';
import type { CancellingParty } from '../../../shared/bookings/cancelling-party';
import { issueProviderStrike } from '../../../shared/strikes/provider-strikes';
import {
  CancelledPaymentOutcome,
  EscrowRefundService,
} from '../../payments/services/escrow-refund.service';
import { expiryReason } from '../../payments/unpaid-reservation';
import { CancelServiceBookingDto } from '../dto/cancel-service-booking.dto';
import { FindServiceBookingsQueryDto } from '../dto/find-service-bookings-query.dto';
import { ServiceBookingPresenter } from '../presenters/service-booking.presenter';
import { ServiceBookingNotifier } from './service-booking-notifier.service';

const USER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

const BOOKING_INCLUDE = {
  service: { select: { id: true, title: true } },
  client: { select: USER_SELECT },
  provider: { select: USER_SELECT },
  payment: {
    select: { id: true, status: true, receiptNumber: true, declaredAt: true },
  },
} satisfies Prisma.ServiceBookingInclude;

const BOOKING_CHANGED =
  'A reserva mudou de estado enquanto o pedido era tratado. Actualiza e tenta de novo.';

/** Quantas reservas o job de expiração trata de cada vez. */
const JOB_BATCH_SIZE = 50;

/** Estados do pagamento em que já não há nada a devolver por cancelamento. */
const SETTLED_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.RELEASED,
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
];

/** As duas partes de uma reserva de serviço. */
interface BookingParties {
  clientId: string;
  providerId: string;
}

/** O que se sabe de um cancelamento antes de o aplicar na transacção. */
interface ServiceCancellation {
  bookingId: string;
  providerId: string;
  actorId: string;
  party: CancellingParty;
  reason: string | null;
}

@Injectable()
export class ServiceBookingsService {
  private readonly logger = new Logger(ServiceBookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly escrowRefunds: EscrowRefundService,
    private readonly notifier: ServiceBookingNotifier,
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
      include: BOOKING_INCLUDE,
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (!(await this.positionOf(userId, booking))) {
      throw new ForbiddenException('Não tens permissão para ver esta reserva.');
    }

    return {
      message: 'Reserva obtida com sucesso.',
      data: ServiceBookingPresenter.toItem(booking),
    };
  }

  async start(providerId: string, bookingId: string) {
    await this.assertIsProviderOf(
      providerId,
      bookingId,
      'Apenas o provider da reserva pode iniciá-la.',
    );

    const started = await this.runSerializable((tx) =>
      this.applyStart(tx, bookingId),
    );

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_STARTED,
      actorId: providerId,
      targetType: 'ServiceBooking',
      targetId: bookingId,
    });

    void this.notifier.started(bookingId);

    return {
      message: 'Execução iniciada com sucesso.',
      data: ServiceBookingPresenter.toItem(started),
    };
  }

  async complete(providerId: string, bookingId: string) {
    await this.assertIsProviderOf(
      providerId,
      bookingId,
      'Apenas o provider da reserva pode concluí-la.',
    );

    const completed = await this.runSerializable((tx) =>
      this.applyCompletion(tx, bookingId),
    );

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_COMPLETED,
      actorId: providerId,
      targetType: 'ServiceBooking',
      targetId: bookingId,
    });

    void this.notifier.completed(bookingId);

    return {
      message:
        'Execução concluída. O cliente deve agora confirmar a entrega e libertar o pagamento.',
      data: ServiceBookingPresenter.toItem(completed),
    };
  }

  /**
   * Cancela a reserva e fecha o pagamento na mesma transacção.
   *
   * Um serviço não tem data combinada, por isso a regra apoia-se no que se
   * consegue verificar: se o dinheiro entrou e se o provider já começou.
   * Antes de começar, qualquer das partes cancela e o cliente recebe tudo de
   * volta. Depois de começar, o cliente já não cancela (confirma ou abre
   * disputa). O provider que desiste de um serviço já pago devolve tudo e
   * leva um strike.
   */
  async cancel(
    userId: string,
    bookingId: string,
    dto: CancelServiceBookingDto,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      select: { id: true, clientId: true, providerId: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    const party = await this.positionOf(userId, booking);

    if (!party) {
      throw new ForbiddenException(
        'Não tens permissão para cancelar esta reserva.',
      );
    }

    const cancellation: ServiceCancellation = {
      bookingId,
      providerId: booking.providerId,
      actorId: userId,
      party,
      reason: dto.reason?.trim() || null,
    };

    const { cancelled, paymentOutcome, providerStruck, suspendedUntil } =
      await this.runSerializable(
        (tx) => this.applyCancellation(tx, cancellation),
        8000,
      );

    if (providerStruck) {
      await this.audit.record({
        action: AuditAction.PROVIDER_STRIKE_ISSUED,
        actorId: userId,
        targetType: 'User',
        targetId: booking.providerId,
        metadata: { serviceBookingId: bookingId },
      });
    }

    if (suspendedUntil) {
      await this.audit.record({
        action: AuditAction.PROVIDER_LISTINGS_SUSPENDED,
        actorId: SYSTEM_ACTOR_ID,
        targetType: 'User',
        targetId: booking.providerId,
        metadata: {
          serviceBookingId: bookingId,
          suspendedUntil: suspendedUntil.toISOString(),
        },
      });
    }

    void this.notifier.cancelled(bookingId, party);

    return {
      message:
        paymentOutcome === CancelledPaymentOutcome.REFUNDED
          ? 'Reserva cancelada. O valor pago vai ser devolvido ao cliente.'
          : 'Reserva cancelada com sucesso.',
      data: ServiceBookingPresenter.toItem(cancelled),
    };
  }

  /**
   * Expira as reservas que passaram o prazo sem o dinheiro entrar no escrow.
   * Chamado pelo ServicesScheduler. Devolve quantas reservas tratou.
   */
  async expireUnpaid(): Promise<number> {
    const now = new Date();

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.serviceBooking.findMany({
          where: { id: { notIn: seenIds }, ...this.unpaidPastDeadline(now) },
          select: { id: true },
          orderBy: { expiresAt: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (booking) => this.expire(booking.id, now),
      onFailure: (booking, error) =>
        this.logger.warn(
          `Expiração falhou para a reserva de serviço ${booking.id}: ${describeError(error)}`,
        ),
    });
  }

  /** Reservas por começar, com o prazo vencido e sem dinheiro no escrow. */
  private unpaidPastDeadline(now: Date): Prisma.ServiceBookingWhereInput {
    return {
      status: ServiceBookingStatus.PENDING,
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

  private async expire(bookingId: string, now: Date): Promise<void> {
    const expired = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { serviceBookingId: bookingId },
        select: { declaredAt: true, declaredReference: true },
      });

      // O filtro repete-se na escrita. Se o pagamento entrou entretanto, a
      // reserva já não tem prazo e deixa de ser apanhada.
      const { count } = await tx.serviceBooking.updateMany({
        where: { id: bookingId, ...this.unpaidPastDeadline(now) },
        data: {
          status: ServiceBookingStatus.EXPIRED,
          cancelledAt: now,
          cancellationReason: expiryReason(payment),
        },
      });

      if (count === 0) {
        return null;
      }

      await tx.payment.updateMany({
        where: { serviceBookingId: bookingId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });

      return { declaredReference: payment?.declaredReference ?? null };
    });

    if (!expired) {
      return;
    }

    await this.audit.record({
      action: AuditAction.SERVICE_BOOKING_EXPIRED,
      actorId: SYSTEM_ACTOR_ID,
      targetType: 'ServiceBooking',
      targetId: bookingId,
      // Com pagamento declarado, a referência fica aqui para o admin
      // reconciliar com o extracto e devolver o dinheiro, se tiver entrado.
      metadata: { declaredReference: expired.declaredReference },
    });

    void this.notifier.expired(bookingId, expired.declaredReference !== null);
  }

  /** O provider só começa com a reserva por iniciar e o dinheiro no escrow. */
  private async applyStart(tx: Prisma.TransactionClient, bookingId: string) {
    const fresh = await tx.serviceBooking.findUnique({
      where: { id: bookingId },
      select: { status: true, payment: { select: { status: true } } },
    });

    if (fresh?.status !== ServiceBookingStatus.PENDING) {
      throw new BadRequestException(
        'Apenas reservas PENDING podem ser iniciadas.',
      );
    }

    if (fresh.payment?.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'Só podes iniciar a execução com o pagamento em estado HELD.',
      );
    }

    return tx.serviceBooking.update({
      where: { id: bookingId },
      data: {
        status: ServiceBookingStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
      include: BOOKING_INCLUDE,
    });
  }

  private async applyCompletion(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ) {
    const fresh = await tx.serviceBooking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });

    if (fresh?.status !== ServiceBookingStatus.IN_PROGRESS) {
      throw new BadRequestException(
        'Apenas reservas IN_PROGRESS podem ser concluídas.',
      );
    }

    return tx.serviceBooking.update({
      where: { id: bookingId },
      data: {
        status: ServiceBookingStatus.COMPLETED,
        completedAt: new Date(),
      },
      include: BOOKING_INCLUDE,
    });
  }

  /**
   * Cancela dentro da transacção: relê a reserva e o pagamento, devolve o
   * dinheiro que estiver no escrow e, se foi o provider a desistir de um
   * serviço pago, regista o strike.
   */
  private async applyCancellation(
    tx: Prisma.TransactionClient,
    cancellation: ServiceCancellation,
  ) {
    const fresh = await tx.serviceBooking.findUnique({
      where: { id: cancellation.bookingId },
      select: {
        status: true,
        payment: { select: { id: true, status: true } },
      },
    });
    this.assertCancellable(fresh, cancellation.party);

    const paymentOutcome = fresh.payment
      ? await this.escrowRefunds.settleCancelled(tx, fresh.payment.id, {
          actorId: cancellation.actorId,
          reason: 'Reembolso total por cancelamento do serviço.',
        })
      : CancelledPaymentOutcome.NOTHING_TO_SETTLE;

    // O strike existe quando havia dinheiro do cliente preso ao compromisso
    // que o provider quebrou.
    const providerStruck =
      cancellation.party === 'PROVIDER' &&
      paymentOutcome === CancelledPaymentOutcome.REFUNDED;

    const suspendedUntil = providerStruck
      ? await issueProviderStrike(tx, {
          providerId: cancellation.providerId,
          serviceBookingId: cancellation.bookingId,
          reason: 'Cancelamento de serviço já pago.',
        })
      : null;

    const cancelled = await tx.serviceBooking.update({
      where: { id: cancellation.bookingId },
      data: {
        status: ServiceBookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: cancellation.reason,
        expiresAt: null,
      },
      include: BOOKING_INCLUDE,
    });

    await this.audit.record(
      {
        action: AuditAction.SERVICE_BOOKING_CANCELLED,
        actorId: cancellation.actorId,
        targetType: 'ServiceBooking',
        targetId: cancellation.bookingId,
        metadata: {
          reason: cancellation.reason,
          cancelledBy: cancellation.party,
          paymentOutcome,
        },
      },
      tx,
    );

    return { cancelled, paymentOutcome, providerStruck, suspendedUntil };
  }

  private assertCancellable(
    booking: {
      status: ServiceBookingStatus;
      payment: { status: PaymentStatus } | null;
    } | null,
    party: CancellingParty,
  ): asserts booking is NonNullable<typeof booking> {
    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    const isOpen =
      booking.status === ServiceBookingStatus.PENDING ||
      booking.status === ServiceBookingStatus.IN_PROGRESS;

    if (!isOpen) {
      throw new BadRequestException(
        'Só se cancela uma reserva por iniciar ou em execução. Depois de concluída, o caminho é a disputa.',
      );
    }

    if (
      booking.payment &&
      SETTLED_PAYMENT_STATUSES.includes(booking.payment.status)
    ) {
      throw new BadRequestException(
        'O pagamento desta reserva já foi libertado ou devolvido, por isso já não há nada a cancelar.',
      );
    }

    if (
      booking.status === ServiceBookingStatus.IN_PROGRESS &&
      party === 'CLIENT'
    ) {
      throw ApiErrors.badRequest(
        ErrorCode.SERVICE_BOOKING_IN_PROGRESS,
        'O serviço já começou e a reserva já não pode ser cancelada. Se houve um problema, abre uma disputa.',
      );
    }
  }

  /**
   * A posição de quem pede em relação à reserva. Quem é parte dela conta
   * como parte, seja qual for o papel da conta. Devolve null a quem não é
   * cliente, provider nem admin.
   */
  private async positionOf(
    userId: string,
    booking: BookingParties,
  ): Promise<CancellingParty | null> {
    if (booking.clientId === userId) return 'CLIENT';
    if (booking.providerId === userId) return 'PROVIDER';

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    return user?.role === UserRole.ADMIN ? 'ADMIN' : null;
  }

  private async assertIsProviderOf(
    userId: string,
    bookingId: string,
    refusal: string,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: bookingId },
      select: { providerId: true },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (booking.providerId !== userId) {
      throw new ForbiddenException(refusal);
    }
  }

  /**
   * Corre `work` numa transacção serializável. Quem perde uma corrida com
   * outro pedido sobre a mesma reserva recebe um 400 em vez de um erro 500.
   */
  private runSerializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    return runSerializable(
      this.prisma,
      work,
      () => new BadRequestException(BOOKING_CHANGED),
      timeoutMs,
    );
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
        include: BOOKING_INCLUDE,
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
