import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  BookingStatus,
  DepositStatus,
  DisputeReason,
  DisputeStatus,
  DisputeType,
  LedgerDirection,
  LedgerParty,
  PaymentStatus,
  PayoutKind,
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
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { percentOf, roundMoney } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import {
  isOpenDispute,
  OPEN_DISPUTE_SELECT,
  OPEN_DISPUTE_STATUSES,
} from '../../../shared/disputes/open-disputes';
import {
  describeError,
  processDue,
} from '../../../shared/scheduling/process-due';
import { depositClaimDeadline } from '../../bookings/booking-deadlines';
import { assertNotPartyToPayment } from '../../payments/money-controls';
import { RENTAL_PAID_OUT_STATUSES } from '../../payments/payment-states';
import { EscrowRefundService } from '../../payments/services/escrow-refund.service';
import { LedgerService } from '../../payments/services/ledger.service';
import { PayoutsService } from '../../payments/services/payouts.service';
import { ClaimDepositDto } from '../dto/claim-deposit.dto';
import { CreateDisputeDto } from '../dto/create-dispute.dto';
import { FindDisputesQueryDto } from '../dto/find-disputes-query.dto';
import { ResolvePartialDto } from '../dto/resolve-partial.dto';
import { RespondDisputeDto } from '../dto/respond-dispute.dto';
import { WithdrawDisputeDto } from '../dto/withdraw-dispute.dto';
import {
  DisputeParties,
  isOwnEvidence,
  rentalStatusBeforeDispute,
  respondentOf,
  responseDeadline,
  serviceStatusBeforeDispute,
} from '../dispute-rules';
import { DisputePresenter } from '../presenters/dispute.presenter';
import { DisputeNotifier } from './dispute-notifier.service';

const DISPUTE_FULL_INCLUDE = {
  booking: {
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      clientId: true,
      ownerId: true,
    },
  },
  serviceBooking: {
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      clientId: true,
      providerId: true,
    },
  },
  payment: {
    select: {
      id: true,
      status: true,
      totalCharged: true,
      receiptNumber: true,
      refundAmount: true,
      rentalAmount: true,
      depositAmount: true,
      depositStatus: true,
    },
  },
  opener: { select: { id: true, name: true, avatarUrl: true } },
} as const;

const DISPUTE_FOR_RESOLUTION_INCLUDE = {
  booking: true,
  serviceBooking: true,
  payment: true,
} satisfies Prisma.DisputeInclude;

type DisputeForResolution = Prisma.DisputeGetPayload<{
  include: typeof DISPUTE_FOR_RESOLUTION_INCLUDE;
}>;

/** O que uma resolução precisa de saber do pagamento, relido dentro da transacção. */
const RESOLUTION_PAYMENT_SELECT = {
  id: true,
  status: true,
  depositStatus: true,
  totalCharged: true,
  rentalAmount: true,
  platformFee: true,
  depositAmount: true,
  ownerPayout: true,
  clientId: true,
  ownerId: true,
} satisfies Prisma.PaymentSelect;

type ResolutionPayment = Prisma.PaymentGetPayload<{
  select: typeof RESOLUTION_PAYMENT_SELECT;
}>;

/** As quatro parcelas em que se reparte um pagamento numa resolução parcial. */
interface RentalSplit {
  refundAmount: number;
  providerPayout: number;
  platformRetained: number;
  depositAmount: number;
}

interface PartialResolution {
  /** Percentagem (1 a 99) que volta ao cliente. */
  refundPercent: number;
  actorId: string;
}

const RESOLUTION_TIMEOUT_MS = 8000;

/** Resposta a quem perdeu a corrida numa resolução: outro pedido chegou primeiro. */
function resolutionConflict() {
  return ApiErrors.conflict(
    ErrorCode.CONFLICT,
    'Outro pedido mexeu nesta disputa ou no pagamento dela ao mesmo tempo. Actualiza e tenta de novo.',
  );
}

/** Estados em que a disputa espera pela resposta da outra parte. */
const AWAITING_RESPONSE: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.AWAITING_OWNER,
];

/**
 * A disputa ainda aceita a resposta da outra parte: está por decidir e
 * ninguém respondeu. O fim do prazo não fecha esta porta. Só deixa o admin
 * decidir sem esperar mais, e uma resposta atrasada ainda lhe chega.
 */
const ACCEPTS_RESPONSE = {
  status: { in: OPEN_DISPUTE_STATUSES },
  respondedAt: null,
} satisfies Prisma.DisputeWhereInput;

/** Quantas disputas o job do prazo de resposta trata de cada vez. */
const JOB_BATCH_SIZE = 50;

const ALREADY_OPEN = 'Já existe uma disputa aberta nesta reserva.';
const RESPONSE_CLOSED = 'Esta disputa já não aceita resposta.';

/** Resposta a quem perdeu a corrida: a reserva mudou enquanto a disputa era aberta. */
function openingConflict() {
  return new BadRequestException(
    'A reserva mudou de estado enquanto abrias a disputa. Actualiza e tenta de novo.',
  );
}

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutsService,
    private readonly escrowRefunds: EscrowRefundService,
    private readonly config: ConfigService,
    private readonly notifier: DisputeNotifier,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    this.assertOwnEvidence(userId, dto.evidenceUrls);

    const bookingId = dto.bookingId?.trim();
    const serviceBookingId = dto.serviceBookingId?.trim();
    const paymentId = dto.paymentId!.trim();

    if ((!bookingId && !serviceBookingId) || (bookingId && serviceBookingId)) {
      throw new BadRequestException(
        'Forneça exactamente um de bookingId ou serviceBookingId.',
      );
    }

    if (bookingId) {
      return this.createBookingDispute(userId, bookingId, paymentId, dto);
    }
    return this.createServiceBookingDispute(
      userId,
      serviceBookingId as string,
      paymentId,
      dto,
    );
  }

  private async createBookingDispute(
    userId: string,
    bookingId: string,
    paymentId: string,
    dto: CreateDisputeDto,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, disputes: OPEN_DISPUTE_SELECT },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (!booking.payment) {
      throw new BadRequestException(
        'Esta reserva ainda não possui pagamento associado.',
      );
    }

    const payment = booking.payment;

    if (payment.id !== paymentId) {
      throw new BadRequestException(
        'O pagamento informado não corresponde à reserva.',
      );
    }

    if (booking.clientId !== userId && booking.ownerId !== userId) {
      throw new ForbiddenException(
        'Não tens permissão para abrir disputa nesta reserva.',
      );
    }

    if (booking.disputes.length > 0) {
      throw new BadRequestException(ALREADY_OPEN);
    }

    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite abrir disputa.',
      );
    }

    const dispute = await runSerializable(
      this.prisma,
      async (tx) => {
        await this.assertStillDisputable(tx, payment.id);
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.DISPUTED },
        });

        return tx.dispute.create({
          data: {
            bookingId: booking.id,
            paymentId: payment.id,
            openedBy: userId,
            reason: dto.reason!,
            description: dto.description!.trim(),
            evidenceUrls: dto.evidenceUrls ?? [],
            status: DisputeStatus.AWAITING_OWNER,
            responseDeadline: responseDeadline(new Date()),
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      openingConflict,
    );

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DISPUTE_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      metadata: {
        bookingId: booking.id,
        paymentId: payment.id,
        reason: dto.reason,
      },
    });

    void this.notifier.opened(dispute.id);

    return {
      message: 'Disputa criada com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  private async createServiceBookingDispute(
    userId: string,
    serviceBookingId: string,
    paymentId: string,
    dto: CreateDisputeDto,
  ) {
    const booking = await this.prisma.serviceBooking.findUnique({
      where: { id: serviceBookingId },
      include: { payment: true, disputes: OPEN_DISPUTE_SELECT },
    });

    if (!booking) {
      throw new NotFoundException('Reserva de serviço não encontrada.');
    }

    if (!booking.payment) {
      throw new BadRequestException(
        'Esta reserva ainda não possui pagamento associado.',
      );
    }

    const payment = booking.payment;

    if (payment.id !== paymentId) {
      throw new BadRequestException(
        'O pagamento informado não corresponde à reserva.',
      );
    }

    if (booking.clientId !== userId && booking.providerId !== userId) {
      throw new ForbiddenException(
        'Não tens permissão para abrir disputa nesta reserva.',
      );
    }

    if (booking.disputes.length > 0) {
      throw new BadRequestException(ALREADY_OPEN);
    }

    if (payment.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite abrir disputa.',
      );
    }

    const dispute = await runSerializable(
      this.prisma,
      async (tx) => {
        await this.assertStillDisputable(tx, payment.id);
        await tx.serviceBooking.update({
          where: { id: booking.id },
          data: { status: ServiceBookingStatus.DISPUTED },
        });

        return tx.dispute.create({
          data: {
            serviceBookingId: booking.id,
            paymentId: payment.id,
            openedBy: userId,
            reason: dto.reason!,
            description: dto.description!.trim(),
            evidenceUrls: dto.evidenceUrls ?? [],
            status: DisputeStatus.AWAITING_OWNER,
            responseDeadline: responseDeadline(new Date()),
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      openingConflict,
    );

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DISPUTE_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      metadata: {
        serviceBookingId: booking.id,
        paymentId: payment.id,
        reason: dto.reason,
      },
    });

    void this.notifier.opened(dispute.id);

    return {
      message: 'Disputa criada com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  /**
   * Reclamação do depósito pelo provider (segundo checkpoint do escrow).
   * Só possível com a reserva ACTIVE, o aluguer já pago ao provider, o
   * depósito HELD e dentro da janela de reclamação após o fim do aluguer.
   * O cliente tem prazo para responder antes de o admin decidir.
   */
  async claimDeposit(userId: string, dto: ClaimDepositDto) {
    this.assertOwnEvidence(userId, dto.evidenceUrls);

    const booking = await this.prisma.booking.findUnique({
      where: { id: dto.bookingId.trim() },
      include: { payment: true, disputes: OPEN_DISPUTE_SELECT },
    });

    if (!booking) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    if (booking.ownerId !== userId) {
      throw new ForbiddenException(
        'Só o proprietário do equipamento pode reclamar o depósito.',
      );
    }

    if (booking.status !== BookingStatus.ACTIVE) {
      throw new BadRequestException(
        'O depósito só pode ser reclamado enquanto a reserva está ativa (antes de confirmar a devolução).',
      );
    }

    if (booking.disputes.length > 0) {
      throw new BadRequestException(ALREADY_OPEN);
    }

    const payment = booking.payment;

    if (!payment || !RENTAL_PAID_OUT_STATUSES.includes(payment.status)) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite reclamar o depósito.',
      );
    }

    if (
      payment.depositStatus !== DepositStatus.HELD ||
      Number(payment.depositAmount) <= 0
    ) {
      throw new BadRequestException(
        'Esta reserva não tem depósito retido para reclamar.',
      );
    }

    if (new Date() > depositClaimDeadline(booking)) {
      throw new BadRequestException(
        'A janela de reclamação do depósito já expirou.',
      );
    }

    const dispute = await runSerializable(
      this.prisma,
      async (tx) => {
        await this.assertDepositStillClaimable(tx, booking.id);
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.DISPUTED },
        });

        return tx.dispute.create({
          data: {
            bookingId: booking.id,
            paymentId: payment.id,
            openedBy: userId,
            type: DisputeType.DEPOSIT,
            reason: dto.reason ?? DisputeReason.DAMAGED,
            description: dto.description.trim(),
            evidenceUrls: dto.evidenceUrls ?? [],
            // O cliente também é ouvido antes de o admin decidir.
            status: DisputeStatus.AWAITING_OWNER,
            responseDeadline: responseDeadline(new Date()),
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      openingConflict,
    );

    this.metrics.businessEvents.inc({ event: 'dispute_opened' });

    await this.audit.record({
      action: AuditAction.DEPOSIT_CLAIM_OPENED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: dispute.id,
      amount: payment.depositAmount,
      metadata: { bookingId: booking.id, paymentId: payment.id },
    });

    void this.notifier.opened(dispute.id);

    return {
      message:
        'Reclamação do depósito registada. O cliente pode responder antes de um administrador decidir.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  async findMyDisputes(userId: string, query: FindDisputesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
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
            OR: [
              { openedBy: userId },
              { booking: { clientId: userId } },
              { booking: { ownerId: userId } },
              { serviceBooking: { clientId: userId } },
              { serviceBooking: { providerId: userId } },
            ],
            ...(query.status ? { status: query.status } : {}),
          };

    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: DISPUTE_FULL_INCLUDE,
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return {
      message: 'Disputas obtidas com sucesso.',
      data: items.map((item) => DisputePresenter.toListItem(item)),
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

  async findOne(userId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: DISPUTE_FULL_INCLUDE,
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const parties = this.disputeParties(dispute);

    const canAccess =
      user.role === UserRole.ADMIN ||
      dispute.openedBy === userId ||
      parties.clientId === userId ||
      parties.ownerId === userId;

    if (!canAccess) {
      throw new ForbiddenException('Não tens permissão para ver esta disputa.');
    }

    return {
      message: 'Disputa obtida com sucesso.',
      data: DisputePresenter.toDetails(dispute),
    };
  }

  private disputeParties(dispute: {
    booking?: { clientId: string; ownerId: string } | null;
    serviceBooking?: { clientId: string; providerId: string } | null;
  }): { clientId: string | null; ownerId: string | null } {
    if (dispute.booking) {
      return {
        clientId: dispute.booking.clientId,
        ownerId: dispute.booking.ownerId,
      };
    }
    if (dispute.serviceBooking) {
      return {
        clientId: dispute.serviceBooking.clientId,
        ownerId: dispute.serviceBooking.providerId,
      };
    }
    return { clientId: null, ownerId: null };
  }

  /**
   * A outra parte responde à disputa, com as suas provas. Responde quem não
   * a abriu: o provider quando abriu o cliente, o cliente quando abriu o
   * provider. Um admin pode registar a resposta por ela, por exemplo depois
   * de a ouvir por telefone. Aceita-se uma resposta só, até a disputa ser
   * decidida ou retirada, mesmo depois do prazo.
   */
  async respond(userId: string, disputeId: string, dto: RespondDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        openedBy: true,
        status: true,
        respondedAt: true,
        booking: { select: { clientId: true, ownerId: true } },
        serviceBooking: { select: { clientId: true, providerId: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const isRespondent =
      respondentOf(this.partiesOf(dispute), dispute.openedBy) === userId;

    if (!isRespondent && !(await this.isAdmin(userId))) {
      throw new ForbiddenException(
        'Não tens permissão para responder a esta disputa.',
      );
    }

    if (!isOpenDispute(dispute.status) || dispute.respondedAt) {
      throw new BadRequestException(RESPONSE_CLOSED);
    }

    this.assertOwnEvidence(userId, dto.evidenceUrls);

    // A condição repete-se na escrita: uma resposta que chega depois de a
    // disputa ser decidida ou retirada não a pode reabrir, e a segunda de
    // duas respostas em simultâneo não apaga a primeira.
    const { count } = await this.prisma.dispute.updateMany({
      where: { id: disputeId, ...ACCEPTS_RESPONSE },
      data: {
        response: dto.response,
        responseEvidenceUrls: dto.evidenceUrls ?? [],
        respondedAt: new Date(),
        respondedBy: userId,
        status: DisputeStatus.UNDER_REVIEW,
      },
    });

    if (count === 0) {
      throw new BadRequestException(RESPONSE_CLOSED);
    }

    const updatedDispute = await this.prisma.dispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: DISPUTE_FULL_INCLUDE,
    });

    await this.audit.record({
      action: AuditAction.DISPUTE_RESPONDED,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      metadata: { onBehalfOfRespondent: !isRespondent },
    });

    void this.notifier.responded(disputeId);

    return {
      message: 'Resposta registada. A disputa segue para análise.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  /**
   * Retira uma disputa ainda por decidir. Quem a abriu pode retirá-la, e um
   * admin pode arquivá-la. Não move dinheiro: a reserva volta ao estado em
   * que estava e segue o caminho normal.
   */
  async withdraw(userId: string, disputeId: string, dto: WithdrawDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      select: { openedBy: true },
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    const byOpener = dispute.openedBy === userId;

    if (!byOpener && !(await this.isAdmin(userId))) {
      throw new ForbiddenException('Só quem abriu a disputa a pode retirar.');
    }

    const reason =
      dto.reason ||
      (byOpener
        ? 'Disputa retirada por quem a abriu.'
        : 'Disputa arquivada por um administrador.');

    const withdrawn = await runSerializable(
      this.prisma,
      (tx) => this.applyWithdrawal(tx, disputeId, { actorId: userId, reason }),
      resolutionConflict,
      RESOLUTION_TIMEOUT_MS,
    );

    await this.audit.record({
      action: AuditAction.DISPUTE_WITHDRAWN,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      metadata: { reason, byOpener },
    });

    void this.notifier.withdrawn(disputeId, { opener: byOpener });

    return {
      message: 'Disputa retirada. A reserva volta ao estado em que estava.',
      data: DisputePresenter.toDetails(withdrawn),
    };
  }

  /**
   * Fecha o prazo de resposta das disputas a que a outra parte não respondeu.
   * A disputa segue para análise sem a resposta, para o dinheiro não ficar
   * parado à espera de quem não aparece. Chamado pelo DisputesScheduler.
   */
  async closeResponseWindows(): Promise<number> {
    const now = new Date();

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.dispute.findMany({
          where: {
            id: { notIn: seenIds },
            status: { in: AWAITING_RESPONSE },
            responseDeadline: { lte: now },
          },
          select: { id: true },
          orderBy: { responseDeadline: 'asc' },
          take: JOB_BATCH_SIZE,
        }),
      handle: (dispute) => this.closeResponseWindow(dispute.id, now),
      onFailure: (dispute, error) =>
        this.logger.warn(
          `Fecho do prazo falhou para a disputa ${dispute.id}: ${describeError(error)}`,
        ),
    });
  }

  private async closeResponseWindow(disputeId: string, now: Date) {
    // Se a outra parte respondeu entretanto, a disputa já não é apanhada.
    const { count } = await this.prisma.dispute.updateMany({
      where: {
        id: disputeId,
        status: { in: AWAITING_RESPONSE },
        responseDeadline: { lte: now },
      },
      data: { status: DisputeStatus.UNDER_REVIEW },
    });

    if (count === 0) {
      return;
    }

    await this.audit.record({
      action: AuditAction.DISPUTE_RESPONSE_WINDOW_CLOSED,
      actorId: SYSTEM_ACTOR_ID,
      targetType: 'Dispute',
      targetId: disputeId,
    });

    void this.notifier.responseWindowClosed(disputeId);
  }

  /**
   * Retira a disputa dentro da transacção: relê o estado e devolve a reserva
   * ao ponto em que estava antes de a disputa ser aberta.
   */
  private async applyWithdrawal(
    tx: Prisma.TransactionClient,
    disputeId: string,
    withdrawal: { actorId: string; reason: string },
  ) {
    const fresh = await tx.dispute.findUnique({
      where: { id: disputeId },
      select: {
        status: true,
        type: true,
        booking: { select: { id: true, status: true } },
        serviceBooking: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    });

    if (!fresh || !isOpenDispute(fresh.status)) {
      throw new BadRequestException(
        'Só se retira uma disputa que ainda está por decidir.',
      );
    }

    if (fresh.booking?.status === BookingStatus.DISPUTED) {
      await tx.booking.update({
        where: { id: fresh.booking.id },
        data: { status: rentalStatusBeforeDispute(fresh.type) },
      });
    } else if (fresh.serviceBooking?.status === ServiceBookingStatus.DISPUTED) {
      await tx.serviceBooking.update({
        where: { id: fresh.serviceBooking.id },
        data: { status: serviceStatusBeforeDispute(fresh.serviceBooking) },
      });
    } else {
      throw new BadRequestException('A reserva já não está em disputa.');
    }

    return tx.dispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.WITHDRAWN,
        resolution: withdrawal.reason,
        ...this.closedBy(withdrawal.actorId),
      },
      include: DISPUTE_FULL_INCLUDE,
    });
  }

  async resolveClient(userId: string, disputeId: string) {
    const dispute = await this.loadForResolution(userId, disputeId);

    const updatedDispute = await runSerializable(
      this.prisma,
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        if (fresh.type === DisputeType.PAYMENT) {
          await this.cancelDisputedReservation(tx, dispute);
          await this.refundDisputedPaymentInFull(tx, fresh.payment, userId);
        } else {
          await this.completeDisputedReservation(tx, dispute);
          await this.returnDepositToClient(tx, fresh.payment, userId);
        }

        return tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_CLIENT,
            resolution: 'Resolvido a favor do cliente.',
            ...this.closedBy(userId),
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      resolutionConflict,
      RESOLUTION_TIMEOUT_MS,
    );

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_CLIENT,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: this.disputedAmount(dispute),
      metadata: { type: dispute.type },
    });

    void this.notifier.resolved(disputeId);

    return {
      message: 'Disputa resolvida a favor do cliente.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  async resolveOwner(userId: string, disputeId: string) {
    const dispute = await this.loadForResolution(userId, disputeId);

    const updatedDispute = await runSerializable(
      this.prisma,
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        await this.closeReservationAfterProviderWin(tx, dispute, fresh.type);

        if (fresh.type === DisputeType.PAYMENT) {
          await this.releaseDisputedPaymentToProvider(
            tx,
            fresh.payment,
            userId,
          );
        } else {
          await this.awardDepositToProvider(tx, fresh.payment, userId);
        }

        return tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_OWNER,
            resolution: 'Resolvido a favor do owner.',
            ...this.closedBy(userId),
          },
          include: DISPUTE_FULL_INCLUDE,
        });
      },
      resolutionConflict,
      RESOLUTION_TIMEOUT_MS,
    );

    await this.audit.record({
      action:
        dispute.type === DisputeType.DEPOSIT
          ? AuditAction.DEPOSIT_CLAIMED
          : AuditAction.DISPUTE_RESOLVED_OWNER,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: this.disputedAmount(dispute),
      metadata: { type: dispute.type },
    });

    void this.notifier.resolved(disputeId);

    return {
      message: 'Disputa resolvida a favor do owner.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  async resolvePartial(
    userId: string,
    disputeId: string,
    dto: ResolvePartialDto,
  ) {
    const dispute = await this.loadForResolution(userId, disputeId);
    const { refundPercent } = dto;

    const { updatedDispute, refundedToClient } = await runSerializable(
      this.prisma,
      async (tx) => {
        const fresh = await this.reloadForResolution(tx, disputeId);

        await this.closeReservationAfterProviderWin(tx, dispute, fresh.type);

        // Numa disputa de pagamento a percentagem incide sobre o rental;
        // numa de depósito, sobre o depósito.
        const refundedToClient =
          fresh.type === DisputeType.PAYMENT
            ? await this.splitDisputedRental(tx, fresh.payment, {
                refundPercent,
                actorId: userId,
              })
            : await this.splitDisputedDeposit(tx, fresh.payment, {
                refundPercent,
                actorId: userId,
              });

        const updatedDispute = await tx.dispute.update({
          where: { id: disputeId },
          data: {
            status: DisputeStatus.RESOLVED_PARTIAL,
            refundPercent,
            resolution: `Resolvido parcialmente com reembolso de ${refundPercent}%.`,
            ...this.closedBy(userId),
          },
          include: DISPUTE_FULL_INCLUDE,
        });

        return { updatedDispute, refundedToClient };
      },
      resolutionConflict,
      RESOLUTION_TIMEOUT_MS,
    );

    await this.audit.record({
      action: AuditAction.DISPUTE_RESOLVED_PARTIAL,
      actorId: userId,
      targetType: 'Dispute',
      targetId: disputeId,
      amount: refundedToClient,
      metadata: { refundPercent, type: dispute.type },
    });

    void this.notifier.resolved(disputeId);

    return {
      message: 'Disputa resolvida parcialmente com sucesso.',
      data: DisputePresenter.toDetails(updatedDispute),
    };
  }

  /**
   * Re-lê disputa+pagamento DENTRO da transacção e revalida o estado —
   * garante que duas resoluções concorrentes não passam ambas.
   */
  private async reloadForResolution(
    tx: Prisma.TransactionClient,
    disputeId: string,
  ) {
    const fresh = await tx.dispute.findUnique({
      where: { id: disputeId },
      select: {
        status: true,
        type: true,
        payment: { select: RESOLUTION_PAYMENT_SELECT },
      },
    });

    if (!fresh) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    this.assertReadyToResolve(fresh.status);

    this.assertPaymentResolvable(fresh.type, fresh.payment);

    return fresh;
  }

  /**
   * Relê o pagamento dentro da transacção. Entre a primeira leitura e a
   * escrita, o cliente pode ter confirmado a entrega ou a outra parte pode
   * ter aberto a sua disputa.
   */
  private async assertStillDisputable(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ) {
    const fresh = await tx.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, disputes: OPEN_DISPUTE_SELECT },
    });

    if (fresh && fresh.disputes.length > 0) {
      throw new BadRequestException(ALREADY_OPEN);
    }

    if (fresh?.status !== PaymentStatus.HELD) {
      throw new BadRequestException(
        'O estado atual do pagamento não permite abrir disputa.',
      );
    }
  }

  /**
   * Relê a reserva dentro da transacção. Entre a primeira leitura e a
   * escrita, a devolução pode ter sido confirmada e o depósito devolvido.
   */
  private async assertDepositStillClaimable(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ) {
    const fresh = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        disputes: OPEN_DISPUTE_SELECT,
        payment: { select: { status: true, depositStatus: true } },
      },
    });

    if (fresh && fresh.disputes.length > 0) {
      throw new BadRequestException(ALREADY_OPEN);
    }

    const depositIsHeld =
      fresh?.status === BookingStatus.ACTIVE &&
      fresh.payment?.depositStatus === DepositStatus.HELD &&
      RENTAL_PAID_OUT_STATUSES.includes(fresh.payment.status);

    if (!depositIsHeld) {
      throw new BadRequestException(
        'A reserva mudou de estado e o depósito já não pode ser reclamado.',
      );
    }
  }

  private assertPaymentResolvable(
    type: DisputeType,
    payment: { status: PaymentStatus; depositStatus: DepositStatus },
  ) {
    if (type === DisputeType.PAYMENT) {
      // Nunca resolver sobre RELEASED: seria desembolso duplo — o provider
      // já recebeu. Disputas de pagamento só existem enquanto HELD.
      if (payment.status !== PaymentStatus.HELD) {
        throw new BadRequestException(
          'O pagamento desta disputa não está num estado válido para resolução.',
        );
      }
    } else {
      if (
        !RENTAL_PAID_OUT_STATUSES.includes(payment.status) ||
        payment.depositStatus !== DepositStatus.HELD
      ) {
        throw new BadRequestException(
          'O depósito desta disputa não está num estado válido para resolução.',
        );
      }
    }
  }

  /**
   * Primeira leitura de uma resolução: confirma que quem resolve é admin, que
   * não é parte da reserva, e que a disputa existe, ainda está aberta e tem o
   * dinheiro num estado que permite resolvê-la.
   */
  private async loadForResolution(userId: string, disputeId: string) {
    await this.assertAdmin(userId);

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: DISPUTE_FOR_RESOLUTION_INCLUDE,
    });

    if (!dispute) {
      throw new NotFoundException('Disputa não encontrada.');
    }

    this.assertReadyToResolve(dispute.status);

    if (!dispute.booking && !dispute.serviceBooking) {
      throw new BadRequestException('Disputa sem reserva associada.');
    }

    this.assertPaymentResolvable(dispute.type, dispute.payment);
    // Uma resolução decide para onde vai o dinheiro: quem é cliente ou dono
    // da reserva não a decide, mesmo sendo admin.
    assertNotPartyToPayment(userId, dispute.payment);

    return dispute;
  }

  /** O valor em causa: o depósito numa disputa de depósito, tudo o que foi cobrado nas outras. */
  private disputedAmount(dispute: DisputeForResolution) {
    return dispute.type === DisputeType.DEPOSIT
      ? dispute.payment.depositAmount
      : dispute.payment.totalCharged;
  }

  /** Cancela a reserva em disputa e, num aluguer, devolve a unidade ao stock. */
  private async cancelDisputedReservation(
    tx: Prisma.TransactionClient,
    dispute: DisputeForResolution,
  ) {
    const cancellation = {
      cancelledAt: new Date(),
      cancellationReason:
        'Cancelada por resolução de disputa a favor do cliente.',
    };

    if (dispute.booking) {
      await tx.booking.update({
        where: { id: dispute.booking.id },
        data: { status: BookingStatus.CANCELLED, ...cancellation },
      });
    } else if (dispute.serviceBooking) {
      await tx.serviceBooking.update({
        where: { id: dispute.serviceBooking.id },
        data: { status: ServiceBookingStatus.CANCELLED, ...cancellation },
      });
    }
  }

  /** Conclui a reserva em disputa e, num aluguer, devolve a unidade ao stock. */
  private async completeDisputedReservation(
    tx: Prisma.TransactionClient,
    dispute: DisputeForResolution,
  ) {
    if (dispute.booking) {
      await tx.booking.update({
        where: { id: dispute.booking.id },
        data: {
          status: BookingStatus.COMPLETED,
          returnConfirmedAt: new Date(),
        },
      });
    } else if (dispute.serviceBooking) {
      await tx.serviceBooking.update({
        where: { id: dispute.serviceBooking.id },
        data: {
          status: ServiceBookingStatus.COMPLETED,
          // Um serviço que o provider já tinha concluído guarda essa data.
          completedAt: dispute.serviceBooking.completedAt ?? new Date(),
        },
      });
    }
  }

  /** Devolve uma função que constrói saídas do ledger para este pagamento e este actor. */
  private outflowFor(paymentId: string, actorId: string) {
    return (party: LedgerParty, amount: number, reason: string) => ({
      paymentId,
      direction: LedgerDirection.OUTFLOW,
      party,
      amount,
      reason,
      actorId,
    });
  }

  /**
   * O cliente ganha a disputa do pagamento: recebe de volta tudo o que
   * pagou (rental, taxa e depósito).
   */
  private async refundDisputedPaymentInFull(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    actorId: string,
  ) {
    await this.escrowRefunds.refundInFull(tx, payment, {
      actorId,
      reason: 'Reembolso total por disputa resolvida a favor do cliente.',
    });
  }

  /** O cliente ganha a disputa do depósito: o depósito volta para ele. */
  private async returnDepositToClient(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    actorId: string,
  ) {
    const outflow = this.outflowFor(payment.id, actorId);
    const depositAmount = roundMoney(Number(payment.depositAmount));

    await this.ledger.record(
      tx,
      outflow(
        LedgerParty.CLIENT,
        depositAmount,
        'Depósito devolvido ao cliente por disputa resolvida a seu favor.',
      ),
    );

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

  /**
   * O provider ganha a disputa do pagamento: recebe o rental menos a taxa e
   * a plataforma fica com a taxa. O depósito, quando existe, continua retido
   * até o equipamento voltar, como numa entrega confirmada pelo cliente.
   */
  private async releaseDisputedPaymentToProvider(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    actorId: string,
  ) {
    const outflow = this.outflowFor(payment.id, actorId);
    const providerPayout = roundMoney(Number(payment.ownerPayout ?? 0));
    const depositAmount = roundMoney(Number(payment.depositAmount ?? 0));
    const platformTake = roundMoney(
      Number(payment.totalCharged) - depositAmount - providerPayout,
    );

    await this.ledger.record(
      tx,
      outflow(
        LedgerParty.PROVIDER,
        providerPayout,
        'Rental liberado ao provider por disputa resolvida a seu favor.',
      ),
    );

    if (platformTake > 0) {
      await this.ledger.record(
        tx,
        outflow(
          LedgerParty.PLATFORM,
          platformTake,
          'Platform fee retida na resolução da disputa.',
        ),
      );
    }

    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.ownerId,
      kind: PayoutKind.PROVIDER_PAYOUT,
      amount: providerPayout,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.RELEASED, releasedAt: new Date() },
    });
  }

  /** O provider ganha a disputa do depósito: fica com ele, por dano. */
  private async awardDepositToProvider(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    actorId: string,
  ) {
    const outflow = this.outflowFor(payment.id, actorId);
    const depositAmount = roundMoney(Number(payment.depositAmount));

    await this.ledger.record(
      tx,
      outflow(
        LedgerParty.PROVIDER,
        depositAmount,
        'Depósito atribuído ao provider por disputa de dano resolvida a seu favor.',
      ),
    );

    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.ownerId,
      kind: PayoutKind.DEPOSIT_CLAIM,
      amount: depositAmount,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        depositStatus: DepositStatus.CLAIMED,
        depositReleasedAt: new Date(),
      },
    });
  }

  /**
   * Como se reparte um pagamento em disputa numa resolução parcial. A
   * percentagem aplica-se só ao rental e a taxa fica com a plataforma. O
   * depósito não entra na repartição: num aluguer continua retido até o
   * equipamento voltar. As três parcelas e o depósito somam o que foi cobrado.
   */
  private splitRental(
    payment: ResolutionPayment,
    refundPercent: number,
  ): RentalSplit {
    const rentalAmount = Number(payment.rentalAmount);
    const depositAmount = roundMoney(Number(payment.depositAmount ?? 0));
    const refundAmount = percentOf(rentalAmount, refundPercent);
    const providerPayout = Math.max(
      0,
      roundMoney(rentalAmount - refundAmount - Number(payment.platformFee)),
    );
    const platformRetained = roundMoney(
      Number(payment.totalCharged) -
        depositAmount -
        refundAmount -
        providerPayout,
    );

    return { refundAmount, providerPayout, platformRetained, depositAmount };
  }

  /**
   * Resolução parcial de uma disputa de pagamento. Devolve o valor
   * reembolsado ao cliente.
   */
  private async splitDisputedRental(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    resolution: PartialResolution,
  ): Promise<number> {
    const split = this.splitRental(payment, resolution.refundPercent);
    const { refundAmount, providerPayout } = split;

    await this.recordRentalSplit(tx, payment, split, resolution);
    await this.createRentalSplitPayouts(tx, payment, split);

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        refundedAt: new Date(),
        releasedAt: new Date(),
        refundAmount,
        ownerPayout: providerPayout,
      },
    });

    return refundAmount;
  }

  private async recordRentalSplit(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    split: RentalSplit,
    resolution: PartialResolution,
  ) {
    const { refundAmount, providerPayout, platformRetained } = split;
    const { refundPercent, actorId } = resolution;
    const outflow = this.outflowFor(payment.id, actorId);

    await this.ledger.recordMany(tx, [
      outflow(
        LedgerParty.CLIENT,
        refundAmount,
        `Reembolso parcial de ${refundPercent}% do rental por disputa.`,
      ),
      ...(providerPayout > 0
        ? [
            outflow(
              LedgerParty.PROVIDER,
              providerPayout,
              'Rental remanescente liberado ao provider na resolução parcial.',
            ),
          ]
        : []),
      ...(platformRetained > 0
        ? [
            outflow(
              LedgerParty.PLATFORM,
              platformRetained,
              'Platform fee retida na resolução parcial.',
            ),
          ]
        : []),
    ]);
  }

  private async createRentalSplitPayouts(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    split: RentalSplit,
  ) {
    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.clientId,
      kind: PayoutKind.CLIENT_REFUND,
      amount: split.refundAmount,
    });
    await this.payouts.createPending(tx, {
      paymentId: payment.id,
      recipientId: payment.ownerId,
      kind: PayoutKind.PROVIDER_PAYOUT,
      amount: split.providerPayout,
    });
  }

  /**
   * Resolução parcial de uma disputa de depósito: a percentagem é a parte do
   * depósito que volta ao cliente e o resto fica com o provider. Devolve a
   * parte do cliente.
   */
  private async splitDisputedDeposit(
    tx: Prisma.TransactionClient,
    payment: ResolutionPayment,
    resolution: PartialResolution,
  ): Promise<number> {
    const { refundPercent, actorId } = resolution;
    const outflow = this.outflowFor(payment.id, actorId);
    const depositAmount = roundMoney(Number(payment.depositAmount));
    const clientPart = percentOf(depositAmount, refundPercent);
    const providerPart = roundMoney(depositAmount - clientPart);

    await this.ledger.recordMany(tx, [
      ...(clientPart > 0
        ? [
            outflow(
              LedgerParty.CLIENT,
              clientPart,
              `Parte do depósito (${refundPercent}%) devolvida ao cliente.`,
            ),
          ]
        : []),
      ...(providerPart > 0
        ? [
            outflow(
              LedgerParty.PROVIDER,
              providerPart,
              'Parte do depósito atribuída ao provider por dano.',
            ),
          ]
        : []),
    ]);

    if (clientPart > 0) {
      await this.payouts.createPending(tx, {
        paymentId: payment.id,
        recipientId: payment.clientId,
        kind: PayoutKind.DEPOSIT_RETURN,
        amount: clientPart,
      });
    }
    if (providerPart > 0) {
      await this.payouts.createPending(tx, {
        paymentId: payment.id,
        recipientId: payment.ownerId,
        kind: PayoutKind.DEPOSIT_CLAIM,
        amount: providerPart,
      });
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        depositStatus: DepositStatus.SPLIT,
        depositReleasedAt: new Date(),
      },
    });

    return clientPart;
  }

  /**
   * Uma disputa só se resolve em análise: depois de a outra parte responder
   * ou de o prazo dela passar. Antes disso decidia-se sem a ouvir.
   */
  private assertReadyToResolve(status: DisputeStatus) {
    if (status === DisputeStatus.UNDER_REVIEW) {
      return;
    }

    if (AWAITING_RESPONSE.includes(status)) {
      throw new BadRequestException(
        'A outra parte ainda pode responder a esta disputa. Só se resolve depois da resposta ou do fim do prazo.',
      );
    }

    throw new BadRequestException(
      status === DisputeStatus.WITHDRAWN
        ? 'Esta disputa foi retirada.'
        : 'Esta disputa já foi resolvida.',
    );
  }

  /**
   * O provider ganhou, no todo ou em parte. Numa disputa de pagamento de um
   * aluguer isso quer dizer que a entrega aconteceu: a reserva fica ACTIVE,
   * o depósito continua retido e segue-se o caminho normal da devolução,
   * com a confirmação do provider ou a reclamação do depósito. Num serviço,
   * ou numa disputa de depósito, a reserva conclui.
   */
  private async closeReservationAfterProviderWin(
    tx: Prisma.TransactionClient,
    dispute: DisputeForResolution,
    type: DisputeType,
  ) {
    if (type === DisputeType.PAYMENT && dispute.booking) {
      await tx.booking.update({
        where: { id: dispute.booking.id },
        data: { status: BookingStatus.ACTIVE, deliveryConfirmedAt: new Date() },
      });
      return;
    }

    await this.completeDisputedReservation(tx, dispute);
  }

  /** Data e autor do fecho de uma disputa, por resolução ou por retirada. */
  private closedBy(actorId: string) {
    return { closedAt: new Date(), closedBy: actorId };
  }

  /** As duas partes da reserva de uma disputa. */
  private partiesOf(dispute: {
    booking?: { clientId: string; ownerId: string } | null;
    serviceBooking?: { clientId: string; providerId: string } | null;
  }): DisputeParties {
    if (dispute.booking) {
      return {
        clientId: dispute.booking.clientId,
        providerId: dispute.booking.ownerId,
      };
    }

    if (dispute.serviceBooking) {
      return {
        clientId: dispute.serviceBooking.clientId,
        providerId: dispute.serviceBooking.providerId,
      };
    }

    throw new BadRequestException('Disputa sem reserva associada.');
  }

  /**
   * Só valem como prova as fotos que o próprio utilizador carregou. Um link
   * de fora, ou a foto de outra pessoa, não entra na disputa.
   */
  private assertOwnEvidence(userId: string, urls: string[] | undefined) {
    if (!urls || urls.length === 0) {
      return;
    }

    const cloudName = this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME');

    if (urls.some((url) => !isOwnEvidence(url, { cloudName, userId }))) {
      throw new BadRequestException(
        'As provas têm de ser fotos que carregaste em /disputes/upload-evidence.',
      );
    }
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    return user?.role === UserRole.ADMIN;
  }

  private async assertAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para executar esta operação.',
      );
    }
  }
}
