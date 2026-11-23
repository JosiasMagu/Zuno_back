import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Booking,
  BookingStatus,
  DepositStatus,
  LedgerDirection,
  LedgerParty,
  PaymentMethod,
  PaymentStatus,
  PayoutKind,
  Prisma,
  ServiceBookingStatus,
  UserRole,
} from '@prisma/client';
import * as crypto from 'crypto';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import {
  AuditService,
  SYSTEM_ACTOR_ID,
} from '../../../shared/audit/audit.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { calculateProviderPayout } from '../../../shared/constants/fees';
import {
  AUTO_RELEASE_REMINDER_HOURS,
  DELIVERY_AUTO_RELEASE_DAYS,
  roundMoney,
  SERVICE_AUTO_RELEASE_DAYS,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import {
  noDisputeBlockingSince,
  OPEN_DISPUTE_SELECT,
} from '../../../shared/disputes/open-disputes';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import {
  describeError,
  processDue,
} from '../../../shared/scheduling/process-due';
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';
import { MarkPaymentHeldDto } from '../dto/mark-payment-held.dto';
import { FindPaymentsQueryDto } from '../dto/find-payments-query.dto';
import { assertNotPartyToPayment, assertNotPayee } from '../money-controls';
import { PaymentPresenter } from '../presenters/payment.presenter';
import { CollectionsService } from './collections.service';
import { EscrowRefundService } from './escrow-refund.service';
import { LedgerService } from './ledger.service';
import { PaymentNotifier } from './payment-notifier.service';
import { PayoutsService } from './payouts.service';

/** Quantos pagamentos o auto-release trata de cada vez. */
const JOB_BATCH_SIZE = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/** O mais tarde de dois instantes. */
function later(a: Date, b: Date): Date {
  return a > b ? a : b;
}

const PAYMENT_WITH_PARTIES_INCLUDE = {
  booking: {
    select: { id: true, startDate: true, endDate: true, status: true },
  },
  serviceBooking: {
    select: { id: true, status: true, scheduledFor: true },
  },
  client: { select: { id: true, name: true, avatarUrl: true } },
  owner: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.PaymentInclude;

/** O que a libertação e o reembolso precisam de saber do pagamento. */
interface PaymentToDecide {
  status: PaymentStatus;
  /** A disputa aberta do pagamento, se houver. */
  disputes: { id: string }[];
}

/** Uma operação sobre o pagamento de uma reserva, de aluguer ou de serviço. */
interface ReservationPaymentAction {
  paymentId: string;
  bookingId: string | null;
  serviceBookingId: string | null;
  /** Quem pediu a acção. Null quando é o sistema a agir sozinho. */
  actorId: string | null;
}

/** Resposta a quem perdeu a corrida: outro pedido alterou o pagamento ao mesmo tempo. */
function paymentConflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu neste pagamento ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
    private readonly escrowRefunds: EscrowRefundService,
    private readonly notifier: PaymentNotifier,
    private readonly collections: CollectionsService,
  ) {}

  async initiate(userId: string, bookingId: string, dto: InitiatePaymentDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        disputes: OPEN_DISPUTE_SELECT,
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

    this.assertAwaitingPayment(booking);

    const payment = await this.createPendingPayment(booking, dto.method);

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
        // A disputa mais recente da reserva, aberta ou já fechada.
        disputes: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true },
        },
        // A cobrança mais recente no telemóvel, para a app mostrar o estado.
        providerOperations: {
          where: { kind: 'COLLECTION' },
          orderBy: { createdAt: 'desc' },
          take: 1,
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
      data: PaymentPresenter.toDetails(payment, {
        seesPayerNumber:
          user.role === UserRole.ADMIN || payment.clientId === userId,
      }),
    };
  }

  /**
   * O admin dá o pagamento como recebido, com o que leu no extracto M-Pesa:
   * a referência da transacção, o valor e o número pagador.
   */
  async markHeld(
    userId: string,
    paymentId: string,
    receipt: MarkPaymentHeldDto,
  ) {
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
        disputes: OPEN_DISPUTE_SELECT,
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    this.assertHoldable(payment);
    this.assertReservationNotCancelled(payment.booking, payment.serviceBooking);

    if (payment.disputes.length > 0) {
      throw new BadRequestException(
        'Não é possível reter pagamento com disputa associada.',
      );
    }

    assertNotPartyToPayment(userId, payment);

    // A entrada do dinheiro, a auditoria e um excesso por devolver ficam
    // todos na mesma transacção, no caminho único das cobranças.
    await this.collections.confirmByAdmin(userId, paymentId, receipt);

    const updatedPayment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: PAYMENT_WITH_PARTIES_INCLUDE,
    });

    void this.notifier.held(updatedPayment.id);

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
        disputes: OPEN_DISPUTE_SELECT,
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

    // Só o cliente (que confirma a entrega ou a execução) ou um admin pode
    // liberar. O provider nunca libera o seu próprio pagamento.
    const canRelease =
      user.role === UserRole.ADMIN || payment.clientId === userId;

    if (!canRelease) {
      throw new ForbiddenException(
        'Só o cliente que fez a reserva ou um administrador pode liberar o pagamento.',
      );
    }

    assertNotPayee(userId, payment);
    this.assertReleasable(payment);
    this.assertReservationAllowsRelease(
      payment.booking,
      payment.serviceBooking,
    );

    const updatedPayment = await runSerializable(
      this.prisma,
      (tx) =>
        this.applyRelease(tx, {
          paymentId,
          bookingId: payment.booking?.id ?? null,
          serviceBookingId: payment.serviceBooking?.id ?? null,
          actorId: userId,
        }),
      paymentConflict,
    );

    await this.audit.record({
      action: AuditAction.PAYMENT_RELEASED,
      actorId: userId,
      targetType: 'Payment',
      targetId: updatedPayment.id,
      amount: updatedPayment.ownerPayout,
    });

    this.metrics.businessEvents.inc({ event: 'payment_released' });
    void this.notifier.released(updatedPayment.id, { automatic: false });

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
        disputes: OPEN_DISPUTE_SELECT,
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    assertNotPartyToPayment(userId, payment);
    this.assertRefundable(payment);

    if (!payment.booking && !payment.serviceBooking) {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    const updatedPayment = await runSerializable(
      this.prisma,
      (tx) =>
        this.applyRefund(tx, {
          paymentId,
          bookingId: payment.booking?.id ?? null,
          serviceBookingId: payment.serviceBooking?.id ?? null,
          actorId: userId,
        }),
      paymentConflict,
    );

    const moneyWasHeld = updatedPayment.status === PaymentStatus.REFUNDED;

    await this.audit.record({
      action: AuditAction.PAYMENT_REFUNDED,
      actorId: userId,
      targetType: 'Payment',
      targetId: updatedPayment.id,
      amount: updatedPayment.refundAmount,
      metadata: { moneyWasHeld },
    });

    return {
      message: moneyWasHeld
        ? 'Pagamento reembolsado com sucesso.'
        : 'Pagamento anulado. O dinheiro não chegou a entrar, por isso não há nada a devolver.',
      data: PaymentPresenter.toListItem(updatedPayment),
    };
  }

  /**
   * Auto-release: o sistema libera os pagamentos retidos que ninguém
   * confirmou nem disputou dentro do prazo. Num aluguer, o prazo conta da
   * entrega prevista. Num serviço, conta de quando o provider o deu por
   * concluído. Chamado pelo BookingsScheduler.
   */
  async autoReleaseDue(): Promise<number> {
    // No aluguer, o prazo conta do início ou da entrada do dinheiro, o que
    // for mais tarde: quem pagou tarde tem o mesmo tempo para disputar.
    const rentalDeadline = daysAgo(DELIVERY_AUTO_RELEASE_DAYS);
    const serviceDeadline = daysAgo(SERVICE_AUTO_RELEASE_DAYS);

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.payment.findMany({
          where: {
            id: { notIn: seenIds },
            status: PaymentStatus.HELD,
            // Dinheiro para uma conta suspensa não sai sozinho: fica retido
            // até um admin o libertar ou reembolsar.
            owner: { isActive: true },
            OR: [
              {
                heldAt: { lte: rentalDeadline },
                disputes: noDisputeBlockingSince(rentalDeadline),
                booking: {
                  status: BookingStatus.CONFIRMED,
                  startDate: { lte: rentalDeadline },
                },
              },
              {
                disputes: noDisputeBlockingSince(serviceDeadline),
                serviceBooking: {
                  status: ServiceBookingStatus.COMPLETED,
                  completedAt: { lte: serviceDeadline },
                },
              },
            ],
          },
          select: { id: true, bookingId: true, serviceBookingId: true },
          orderBy: { heldAt: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (payment) => this.releaseAutomatically(payment),
      onFailure: (payment, error) =>
        this.logger.warn(
          `Auto-release falhou para o pagamento ${payment.id}: ${describeError(error)}`,
        ),
    });
  }

  /**
   * O sistema libera o pagamento sem ninguém a pedir. Fica em auditoria como
   * acção do sistema, e não do cliente.
   */
  private async releaseAutomatically(payment: {
    id: string;
    bookingId: string | null;
    serviceBookingId: string | null;
  }): Promise<void> {
    const released = await runSerializable(
      this.prisma,
      (tx) =>
        this.applyRelease(tx, {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          serviceBookingId: payment.serviceBookingId,
          actorId: null,
        }),
      // Se alguém mexeu no pagamento ao mesmo tempo, fica para a hora seguinte.
      paymentConflict,
    );

    await this.audit.record({
      action: AuditAction.PAYMENT_AUTO_RELEASED,
      actorId: SYSTEM_ACTOR_ID,
      targetType: 'Payment',
      targetId: payment.id,
      amount: released.ownerPayout,
      metadata: {
        reason: payment.serviceBookingId
          ? 'service_confirmation_window_expired'
          : 'delivery_confirmation_window_expired',
      },
    });

    this.metrics.businessEvents.inc({ event: 'payment_released' });
    void this.notifier.released(payment.id, { automatic: true });
  }

  /**
   * Avisa o cliente, uma vez, de que o pagamento vai ser libertado sozinho
   * nas próximas AUTO_RELEASE_REMINDER_HOURS horas, se não confirmar nem
   * reportar um problema. Chamado pelo scheduler, de hora a hora.
   */
  async remindAutoReleaseDue(): Promise<number> {
    const horizonMs = AUTO_RELEASE_REMINDER_HOURS * HOUR_MS;
    const rentalCutoff = new Date(
      daysAgo(DELIVERY_AUTO_RELEASE_DAYS).getTime() + horizonMs,
    );
    const serviceCutoff = new Date(
      daysAgo(SERVICE_AUTO_RELEASE_DAYS).getTime() + horizonMs,
    );

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.payment.findMany({
          where: {
            id: { notIn: seenIds },
            status: PaymentStatus.HELD,
            autoReleaseReminderAt: null,
            OR: [
              {
                heldAt: { lte: rentalCutoff },
                disputes: noDisputeBlockingSince(rentalCutoff),
                booking: {
                  status: BookingStatus.CONFIRMED,
                  startDate: { lte: rentalCutoff },
                },
              },
              {
                disputes: noDisputeBlockingSince(serviceCutoff),
                serviceBooking: {
                  status: ServiceBookingStatus.COMPLETED,
                  completedAt: { lte: serviceCutoff },
                },
              },
            ],
          },
          select: {
            id: true,
            heldAt: true,
            booking: { select: { startDate: true } },
            serviceBooking: { select: { completedAt: true } },
          },
          orderBy: { heldAt: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (payment) => this.remindAutoRelease(payment),
      onFailure: (payment, error) =>
        this.logger.warn(
          `Lembrete da libertação falhou para o pagamento ${payment.id}: ${describeError(error)}`,
        ),
    });
  }

  private async remindAutoRelease(payment: {
    id: string;
    heldAt: Date | null;
    booking: { startDate: Date } | null;
    serviceBooking: { completedAt: Date | null } | null;
  }) {
    // A condição repete-se na escrita: o lembrete sai uma vez só.
    const { count } = await this.prisma.payment.updateMany({
      where: { id: payment.id, autoReleaseReminderAt: null },
      data: { autoReleaseReminderAt: new Date() },
    });
    if (count === 0) {
      return;
    }

    const releaseAt = payment.booking
      ? new Date(
          later(
            payment.heldAt ?? new Date(),
            payment.booking.startDate,
          ).getTime() +
            DELIVERY_AUTO_RELEASE_DAYS * DAY_MS,
        )
      : new Date(
          (payment.serviceBooking?.completedAt ?? new Date()).getTime() +
            SERVICE_AUTO_RELEASE_DAYS * DAY_MS,
        );

    void this.notifier.autoReleaseReminder(payment.id, releaseAt);
  }

  /** Só se paga uma reserva confirmada, sem disputa e ainda sem pagamento. */
  private assertAwaitingPayment(booking: {
    status: BookingStatus;
    disputes: object[];
    payment: object | null;
  }) {
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        'Apenas reservas confirmadas podem ter pagamento iniciado.',
      );
    }

    if (booking.disputes.length > 0) {
      throw new BadRequestException(
        'Não é possível iniciar pagamento para uma reserva com disputa associada.',
      );
    }

    if (booking.payment) {
      throw new BadRequestException(
        'Já existe um pagamento associado a esta reserva.',
      );
    }
  }

  /**
   * Cria o pagamento PENDING de uma reserva, com os valores que a reserva
   * fixou quando foi criada. O dinheiro só entra no escrow no mark-held.
   */
  private async createPendingPayment(booking: Booking, method: PaymentMethod) {
    const receiptNumber = await this.generateUniqueReceiptNumber();

    return this.prisma.payment.create({
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
        method,
        status: PaymentStatus.PENDING,
        depositHeldAmount: booking.depositAmount,
        receiptNumber,
      },
      include: PAYMENT_WITH_PARTIES_INCLUDE,
    });
  }

  private assertHoldable(
    payment: { status: PaymentStatus } | null,
  ): asserts payment is { status: PaymentStatus } {
    if (payment?.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        'Apenas pagamentos pendentes podem ser marcados como retidos.',
      );
    }
  }

  private assertReservationNotCancelled(
    booking: { status: BookingStatus } | null,
    serviceBooking: { status: ServiceBookingStatus } | null,
  ) {
    if (!booking && !serviceBooking) {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    const cancelled = booking
      ? booking.status === BookingStatus.CANCELLED
      : serviceBooking?.status === ServiceBookingStatus.CANCELLED;

    if (cancelled) {
      throw new BadRequestException(
        'Não é possível reter pagamento de uma reserva cancelada.',
      );
    }
  }

  private assertReleasable(
    payment: PaymentToDecide | null,
  ): asserts payment is PaymentToDecide {
    if (payment?.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'Apenas pagamentos retidos podem ser liberados.',
      );
    }

    if (payment.disputes.length > 0) {
      throw new BadRequestException(
        'Não é possível liberar pagamento com disputa associada.',
      );
    }
  }

  /**
   * Num aluguer, o release é a confirmação da entrega, por isso a reserva tem
   * de estar CONFIRMED. Num serviço, o cliente libera depois de o provider o
   * concluir, ou ainda durante a execução.
   */
  private assertReservationAllowsRelease(
    booking: { status: BookingStatus } | null,
    serviceBooking: { status: ServiceBookingStatus } | null,
  ) {
    if (booking) {
      if (booking.status !== BookingStatus.CONFIRMED) {
        throw new BadRequestException(
          'O estado atual da reserva não permite liberação do pagamento.',
        );
      }
      return;
    }

    if (!serviceBooking) {
      throw new BadRequestException('Pagamento sem reserva associada.');
    }

    if (
      serviceBooking.status !== ServiceBookingStatus.IN_PROGRESS &&
      serviceBooking.status !== ServiceBookingStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'O estado atual da reserva de serviço não permite liberação do pagamento.',
      );
    }
  }

  /**
   * Libera o pagamento dentro da transacção: relê o estado, marca a entrega
   * na reserva, regista as saídas do escrow e cria o payout do provider.
   */
  private async applyRelease(
    tx: Prisma.TransactionClient,
    release: ReservationPaymentAction,
  ) {
    const { paymentId, bookingId, serviceBookingId, actorId } = release;

    const fresh = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        totalCharged: true,
        depositAmount: true,
        ownerPayout: true,
        ownerId: true,
        disputes: OPEN_DISPUTE_SELECT,
      },
    });
    this.assertReleasable(fresh);

    await this.markReservationDelivered(tx, bookingId, serviceBookingId);

    const providerPayout = roundMoney(Number(fresh.ownerPayout ?? 0));
    const depositAmount = roundMoney(Number(fresh.depositAmount ?? 0));

    await this.payProviderFromEscrow(tx, {
      paymentId,
      providerId: fresh.ownerId,
      providerPayout,
      platformTake: roundMoney(
        Number(fresh.totalCharged) - depositAmount - providerPayout,
      ),
      actorId,
    });

    // Num aluguer com depósito, este continua retido até à devolução do
    // equipamento. Nos outros casos nada fica no escrow depois do release.
    const keepsDepositHeld = bookingId !== null && depositAmount > 0;

    return tx.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.RELEASED,
        releasedAt: new Date(),
        ...(keepsDepositHeld
          ? {}
          : {
              depositStatus: DepositStatus.NONE,
              depositReleasedAt: new Date(),
            }),
      },
      include: PAYMENT_WITH_PARTIES_INCLUDE,
    });
  }

  /**
   * Regista no ledger o que sai do escrow no release (a parte do provider e a
   * da plataforma) e cria o payout pendente do provider.
   */
  private async payProviderFromEscrow(
    tx: Prisma.TransactionClient,
    payout: {
      paymentId: string;
      providerId: string;
      providerPayout: number;
      platformTake: number;
      actorId: string | null;
    },
  ) {
    const { paymentId, providerId, providerPayout, platformTake, actorId } =
      payout;

    await this.ledger.record(tx, {
      paymentId,
      direction: LedgerDirection.OUTFLOW,
      party: LedgerParty.PROVIDER,
      amount: providerPayout,
      reason: 'Rental liberado ao provider após confirmação de entrega.',
      actorId,
    });

    if (platformTake > 0) {
      await this.ledger.record(tx, {
        paymentId,
        direction: LedgerDirection.OUTFLOW,
        party: LedgerParty.PLATFORM,
        amount: platformTake,
        reason: 'Platform fee retida na liberação do pagamento.',
        actorId,
      });
    }

    await this.payouts.createPending(tx, {
      paymentId,
      recipientId: providerId,
      kind: PayoutKind.PROVIDER_PAYOUT,
      amount: providerPayout,
    });
  }

  /**
   * O equipamento passa a estar com o cliente (reserva ACTIVE), ou o serviço
   * fica dado como concluído.
   */
  private async markReservationDelivered(
    tx: Prisma.TransactionClient,
    bookingId: string | null,
    serviceBookingId: string | null,
  ) {
    if (bookingId) {
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.ACTIVE,
          deliveryConfirmedAt: new Date(),
        },
      });
    } else if (serviceBookingId) {
      const serviceBooking = await tx.serviceBooking.findUnique({
        where: { id: serviceBookingId },
        select: { status: true, completedAt: true },
      });
      this.assertReservationAllowsRelease(null, serviceBooking);

      await tx.serviceBooking.update({
        where: { id: serviceBookingId },
        data: {
          status: ServiceBookingStatus.COMPLETED,
          // Se o provider já o tinha dado por concluído, fica a data dele: é
          // dela que conta o prazo do auto-release.
          completedAt: serviceBooking?.completedAt ?? new Date(),
        },
      });
    }
  }

  private assertRefundable<T extends PaymentToDecide>(
    payment: T | null,
  ): asserts payment is T {
    if (
      payment?.status !== PaymentStatus.PENDING &&
      payment?.status !== PaymentStatus.HELD
    ) {
      throw new BadRequestException(
        'Apenas pagamentos pendentes ou retidos podem ser reembolsados.',
      );
    }

    if (payment.disputes.length > 0) {
      throw new BadRequestException(
        'Este pagamento tem uma disputa aberta. O reembolso decide-se na resolução da disputa.',
      );
    }
  }

  /**
   * Reembolsa dentro da transacção: relê o estado e cancela a reserva. Se o
   * dinheiro chegou a entrar no escrow, regista a saída e cria o payout. Se
   * não chegou, o pagamento fica FAILED e não se regista reembolso nenhum.
   */
  private async applyRefund(
    tx: Prisma.TransactionClient,
    refund: ReservationPaymentAction,
  ) {
    const { paymentId, bookingId, serviceBookingId, actorId } = refund;

    const fresh = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        totalCharged: true,
        depositStatus: true,
        clientId: true,
        // Uma disputa pode ter sido aberta entre a leitura de fora e aqui.
        disputes: OPEN_DISPUTE_SELECT,
      },
    });
    this.assertRefundable(fresh);

    await this.cancelReservationForRefund(tx, bookingId, serviceBookingId);

    if (fresh.status === PaymentStatus.PENDING) {
      return tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.FAILED },
        include: PAYMENT_WITH_PARTIES_INCLUDE,
      });
    }

    await this.escrowRefunds.refundInFull(
      tx,
      { ...fresh, id: paymentId },
      { actorId, reason: 'Reembolso total ao cliente.' },
    );

    return tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: PAYMENT_WITH_PARTIES_INCLUDE,
    });
  }

  private async cancelReservationForRefund(
    tx: Prisma.TransactionClient,
    bookingId: string | null,
    serviceBookingId: string | null,
  ) {
    const cancellation = {
      cancelledAt: new Date(),
      cancellationReason: 'Reserva cancelada por reembolso do pagamento.',
    };

    if (bookingId) {
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED, ...cancellation },
      });
    } else if (serviceBookingId) {
      await tx.serviceBooking.update({
        where: { id: serviceBookingId },
        data: { status: ServiceBookingStatus.CANCELLED, ...cancellation },
      });
    }
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

    const result = await this.initiate(userId, bookingId, { method: 'MPESA' });
    const paymentId = result.data.id;

    // O mesmo caminho do dinheiro real: ledger, auditoria e reserva sem prazo.
    await this.collections.confirmSimulated(userId, paymentId);

    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: PAYMENT_WITH_PARTIES_INCLUDE,
    });

    void this.notifier.held(paymentId);

    return {
      message: 'Pagamento M-Pesa simulado com sucesso. Valor retido no cofre.',
      data: PaymentPresenter.toListItem(payment),
    };
  }
}
