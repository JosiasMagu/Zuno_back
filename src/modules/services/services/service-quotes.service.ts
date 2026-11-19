import * as crypto from 'crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
  ServiceQuoteStatus,
  ServiceRequestStatus,
  ServiceStatus,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { calculatePlatformFee } from '../../../shared/constants/fees';
import {
  percentOf,
  roundMoney,
  SERVICE_PAYMENT_WINDOW_HOURS,
} from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { carriesOnWork } from '../../../shared/moderation/listing-moderation';
import { CreateServiceQuoteDto } from '../dto/create-service-quote.dto';
import { ServiceQuotePresenter } from '../presenters/service-quote.presenter';
import { ServiceBookingNotifier } from './service-booking-notifier.service';

const PROVIDER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

const REQUEST_SELECT = {
  id: true,
  clientId: true,
  description: true,
  isUrgent: true,
  status: true,
  serviceId: true,
} as const;

const QUOTE_FOR_ACCEPTANCE_INCLUDE = {
  request: {
    select: {
      id: true,
      clientId: true,
      status: true,
      isUrgent: true,
      serviceId: true,
      expiresAt: true,
    },
  },
} satisfies Prisma.ServiceQuoteInclude;

/** O que a aceitação de um orçamento leva para dentro da transacção. */
interface QuoteAcceptance {
  quoteId: string;
  isUrgent: boolean;
  serviceAmount: number;
  platformFee: number;
  /** O que o cliente paga: o valor do orçamento mais a taxa. */
  totalAmount: number;
}

const DEFAULT_QUOTE_EXPIRY_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

/** O que recebe quem perde uma corrida com outro pedido sobre o mesmo orçamento. */
const quoteConflict = () =>
  new BadRequestException(
    'O pedido ou o orçamento mudou enquanto o pedido era tratado. Actualiza e tenta de novo.',
  );

const RECEIPT_MAX_ATTEMPTS = 5;

@Injectable()
export class ServiceQuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: ServiceBookingNotifier,
  ) {}

  async create(
    providerId: string,
    requestId: string,
    dto: CreateServiceQuoteDto,
  ) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        service: {
          select: {
            id: true,
            providerId: true,
            acceptsUrgent: true,
            urgentSurcharge: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Pedido não encontrado.');
    }

    // Orçamenta quem é dono do serviço pedido. O papel da conta não entra
    // na decisão.
    if (request.service.providerId !== providerId) {
      throw new ForbiddenException(
        'Apenas o provider do serviço pode orçamentar este pedido.',
      );
    }

    if (
      request.status !== ServiceRequestStatus.OPEN &&
      request.status !== ServiceRequestStatus.QUOTED
    ) {
      throw new BadRequestException(
        'Apenas pedidos OPEN ou QUOTED aceitam novos orçamentos.',
      );
    }

    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Este pedido já expirou.');
    }

    this.validateQuoteTotals(dto, request);

    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + DEFAULT_QUOTE_EXPIRY_HOURS * 60 * 60 * 1000);

    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'A data de expiração deve estar no futuro.',
      );
    }

    const created = await runSerializable(
      this.prisma,
      (tx) => this.saveQuote(tx, { providerId, requestId, dto, expiresAt }),
      quoteConflict,
    );

    await this.audit.record({
      action: AuditAction.SERVICE_QUOTE_SUBMITTED,
      actorId: providerId,
      targetType: 'ServiceQuote',
      targetId: created.id,
      amount: dto.totalAmount,
      metadata: { requestId },
    });

    return {
      message: 'Orçamento enviado com sucesso.',
      data: ServiceQuotePresenter.toItem(created),
    };
  }

  async findReceived(clientId: string) {
    const quotes = await this.prisma.serviceQuote.findMany({
      where: { request: { clientId } },
      orderBy: { createdAt: 'desc' },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

    return {
      message: 'Orçamentos recebidos com sucesso.',
      data: quotes.map((q) => ServiceQuotePresenter.toItem(q)),
    };
  }

  async findSent(providerId: string) {
    const quotes = await this.prisma.serviceQuote.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

    return {
      message: 'Orçamentos enviados obtidos com sucesso.',
      data: quotes.map((q) => ServiceQuotePresenter.toItem(q)),
    };
  }

  async accept(clientId: string, quoteId: string) {
    const quote = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      include: QUOTE_FOR_ACCEPTANCE_INCLUDE,
    });

    if (!quote) {
      throw new NotFoundException('Orçamento não encontrado.');
    }

    if (quote.request.clientId !== clientId) {
      throw new ForbiddenException(
        'Apenas o cliente do pedido pode aceitar este orçamento.',
      );
    }

    this.assertQuoteAcceptable(quote);

    const acceptance: QuoteAcceptance = {
      quoteId,
      isUrgent: quote.request.isUrgent,
      ...this.priceAcceptedQuote(Number(quote.totalAmount)),
    };

    const result = await runSerializable(
      this.prisma,
      (tx) => this.applyAcceptance(tx, acceptance),
      quoteConflict,
    );

    await this.audit.record({
      action: AuditAction.SERVICE_QUOTE_ACCEPTED,
      actorId: clientId,
      targetType: 'ServiceQuote',
      targetId: quoteId,
      amount: acceptance.totalAmount,
      metadata: {
        serviceBookingId: result.booking.id,
        paymentId: result.payment.id,
      },
    });

    await this.audit.record({
      action: AuditAction.PAYMENT_INITIATED,
      actorId: clientId,
      targetType: 'Payment',
      targetId: result.payment.id,
      amount: acceptance.totalAmount,
      metadata: { serviceBookingId: result.booking.id },
    });

    const accepted = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

    void this.notifier.quoteAccepted(result.booking.id);

    return {
      message:
        'Orçamento aceite. A reserva fica à espera do pagamento por M-Pesa.',
      data: {
        quote: accepted ? ServiceQuotePresenter.toItem(accepted) : null,
        serviceBookingId: result.booking.id,
        paymentId: result.payment.id,
        // Até quando a reserva pode ser paga.
        payBy: result.booking.expiresAt,
      },
    };
  }

  async reject(clientId: string, quoteId: string) {
    const quote = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      include: {
        request: { select: { clientId: true } },
      },
    });

    if (!quote) {
      throw new NotFoundException('Orçamento não encontrado.');
    }

    if (quote.request.clientId !== clientId) {
      throw new ForbiddenException(
        'Apenas o cliente do pedido pode rejeitar este orçamento.',
      );
    }

    if (quote.status !== ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'Apenas orçamentos pendentes podem ser rejeitados.',
      );
    }

    const updated = await this.closePendingQuote(
      quoteId,
      ServiceQuoteStatus.REJECTED,
      'Apenas orçamentos pendentes podem ser rejeitados.',
    );

    return {
      message: 'Orçamento rejeitado.',
      data: ServiceQuotePresenter.toItem(updated),
    };
  }

  async withdraw(providerId: string, quoteId: string) {
    const quote = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      select: { id: true, providerId: true, status: true },
    });

    if (!quote) {
      throw new NotFoundException('Orçamento não encontrado.');
    }

    if (quote.providerId !== providerId) {
      throw new ForbiddenException(
        'Apenas o provider que enviou pode retirar este orçamento.',
      );
    }

    if (quote.status !== ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'Apenas orçamentos pendentes podem ser retirados.',
      );
    }

    const updated = await this.closePendingQuote(
      quoteId,
      ServiceQuoteStatus.WITHDRAWN,
      'Apenas orçamentos pendentes podem ser retirados.',
    );

    return {
      message: 'Orçamento retirado.',
      data: ServiceQuotePresenter.toItem(updated),
    };
  }

  /**
   * Grava o orçamento dentro da transacção. O pedido é relido aqui: se foi
   * fechado, cancelado ou expirou entretanto, já não recebe orçamentos.
   */
  private async saveQuote(
    tx: Prisma.TransactionClient,
    input: {
      providerId: string;
      requestId: string;
      dto: CreateServiceQuoteDto;
      expiresAt: Date;
    },
  ) {
    const { providerId, requestId, dto, expiresAt } = input;
    const request = await this.reloadOpenRequest(tx, requestId);

    const existing = await tx.serviceQuote.findUnique({
      where: {
        requestId_providerId: { requestId, providerId },
      },
    });

    if (existing && existing.status === ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'Já tens um orçamento pendente para este pedido.',
      );
    }

    const quote = existing
      ? await tx.serviceQuote.update({
          where: { id: existing.id },
          data: {
            amount: dto.amount,
            urgentSurcharge: dto.urgentSurcharge ?? null,
            totalAmount: dto.totalAmount,
            estimatedDays: dto.estimatedDays,
            message: dto.message?.trim() ?? null,
            status: ServiceQuoteStatus.PENDING,
            expiresAt,
          },
          include: {
            provider: { select: PROVIDER_SELECT },
            request: { select: REQUEST_SELECT },
          },
        })
      : await tx.serviceQuote.create({
          data: {
            requestId,
            providerId,
            amount: dto.amount,
            urgentSurcharge: dto.urgentSurcharge,
            totalAmount: dto.totalAmount,
            estimatedDays: dto.estimatedDays,
            message: dto.message?.trim(),
            status: ServiceQuoteStatus.PENDING,
            expiresAt,
          },
          include: {
            provider: { select: PROVIDER_SELECT },
            request: { select: REQUEST_SELECT },
          },
        });

    if (request.status === ServiceRequestStatus.OPEN) {
      await tx.serviceRequest.update({
        where: { id: requestId },
        data: { status: ServiceRequestStatus.QUOTED },
      });
    }

    return quote;
  }

  /** Relê o pedido e confirma que continua aberto a orçamentos e dentro do prazo. */
  private async reloadOpenRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
  ) {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: { status: true, expiresAt: true },
    });

    if (!request || !this.isOpenToQuotes(request.status)) {
      throw new BadRequestException(
        'Apenas pedidos OPEN ou QUOTED aceitam novos orçamentos.',
      );
    }

    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Este pedido já expirou.');
    }

    return request;
  }

  /**
   * Fecha um orçamento pendente. A condição repete-se na escrita: se o
   * orçamento foi aceite, retirado ou rejeitado entretanto, quem chegou
   * depois é recusado em vez de escrever por cima.
   */
  private async closePendingQuote(
    quoteId: string,
    status: ServiceQuoteStatus,
    refusal: string,
  ) {
    const { count } = await this.prisma.serviceQuote.updateMany({
      where: { id: quoteId, status: ServiceQuoteStatus.PENDING },
      data: { status },
    });

    if (count === 0) {
      throw new BadRequestException(refusal);
    }

    return this.prisma.serviceQuote.findUniqueOrThrow({
      where: { id: quoteId },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });
  }

  private assertQuoteAcceptable(quote: {
    status: ServiceQuoteStatus;
    expiresAt: Date | null;
    request: { status: ServiceRequestStatus };
  }) {
    if (quote.status !== ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'Apenas orçamentos pendentes podem ser aceites.',
      );
    }

    if (quote.expiresAt && quote.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Este orçamento já expirou.');
    }

    if (!this.isOpenToQuotes(quote.request.status)) {
      throw new BadRequestException(
        'Apenas pedidos OPEN ou QUOTED podem ter orçamentos aceites.',
      );
    }
  }

  /** Um pedido aceita orçamentos enquanto está aberto ou só orçamentado. */
  private isOpenToQuotes(status: ServiceRequestStatus) {
    return (
      status === ServiceRequestStatus.OPEN ||
      status === ServiceRequestStatus.QUOTED
    );
  }

  /** O cliente paga o valor do orçamento mais a taxa da plataforma. */
  private priceAcceptedQuote(serviceAmount: number) {
    const platformFee = calculatePlatformFee(serviceAmount);

    return {
      serviceAmount,
      platformFee,
      totalAmount: roundMoney(serviceAmount + platformFee),
    };
  }

  /**
   * Aceita o orçamento dentro da transacção: fecha o pedido com este
   * orçamento e cria a reserva de serviço e o pagamento, os dois PENDING.
   */
  private async applyAcceptance(
    tx: Prisma.TransactionClient,
    acceptance: QuoteAcceptance,
  ) {
    const { serviceAmount, platformFee, totalAmount } = acceptance;
    const { quote, request } = await this.reloadForAcceptance(
      tx,
      acceptance.quoteId,
    );

    await this.closeRequestWithQuote(tx, request.id, quote.id);

    const booking = await tx.serviceBooking.create({
      data: {
        clientId: request.clientId,
        providerId: quote.providerId,
        serviceId: request.serviceId,
        requestId: request.id,
        quoteId: quote.id,
        isUrgent: acceptance.isUrgent,
        serviceAmount,
        platformFee,
        totalAmount,
        status: ServiceBookingStatus.PENDING,
        // A data que o cliente indicou no pedido, só como informação. O
        // orçamento não a confirma, por isso nenhum prazo depende dela.
        scheduledFor: request.preferredDate,
        expiresAt: new Date(
          Date.now() + SERVICE_PAYMENT_WINDOW_HOURS * HOUR_MS,
        ),
      },
    });

    const receiptNumber = await this.generateReceiptNumber(tx);

    const payment = await tx.payment.create({
      data: {
        serviceBookingId: booking.id,
        clientId: request.clientId,
        ownerId: quote.providerId,
        rentalAmount: serviceAmount,
        depositAmount: 0,
        platformFee,
        totalCharged: totalAmount,
        ownerPayout: serviceAmount - platformFee,
        method: PaymentMethod.MPESA,
        status: PaymentStatus.PENDING,
        receiptNumber,
      },
    });

    return { booking, payment };
  }

  /**
   * Relê o orçamento, o pedido e o serviço dentro da transacção. Duas
   * aceitações em simultâneo não passam as duas, e não se aceita um
   * orçamento que expirou, de um pedido que fechou ou de um serviço que
   * saiu do catálogo entretanto.
   */
  private async reloadForAcceptance(
    tx: Prisma.TransactionClient,
    quoteId: string,
  ) {
    const now = new Date();

    const quote = await tx.serviceQuote.findUnique({
      where: { id: quoteId },
      select: {
        id: true,
        status: true,
        requestId: true,
        providerId: true,
        expiresAt: true,
      },
    });

    if (quote?.status !== ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'O orçamento já não está disponível para aceitação.',
      );
    }

    if (quote.expiresAt && quote.expiresAt <= now) {
      throw new BadRequestException('Este orçamento já expirou.');
    }

    const request = await tx.serviceRequest.findUnique({
      where: { id: quote.requestId },
      select: {
        id: true,
        clientId: true,
        status: true,
        serviceId: true,
        expiresAt: true,
        preferredDate: true,
        service: {
          select: {
            status: true,
            provider: { select: { listingsSuspendedUntil: true } },
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Pedido não encontrado.');
    }

    if (!this.isOpenToQuotes(request.status)) {
      throw new BadRequestException(
        'O pedido já não está disponível para aceitar orçamentos.',
      );
    }

    if (request.expiresAt && request.expiresAt <= now) {
      throw new BadRequestException('Este pedido já expirou.');
    }

    this.assertServiceTakesWork(request.service);

    return { quote, request };
  }

  /**
   * Um serviço rejeitado ou removido, ou de um provider suspenso por strikes,
   * não ganha trabalho novo, mesmo com um orçamento já enviado. Um serviço
   * que voltou à revisão por ter sido editado leva adiante os pedidos que já
   * tinha: só se pede um serviço activo, por isso o pedido nasceu aprovado.
   */
  private assertServiceTakesWork(service: {
    status: ServiceStatus;
    provider: { listingsSuspendedUntil: Date | null };
  }) {
    const suspendedUntil = service.provider.listingsSuspendedUntil;

    if (
      !carriesOnWork(service.status) ||
      (suspendedUntil && suspendedUntil > new Date())
    ) {
      throw new BadRequestException(
        'Este serviço já não está a aceitar trabalhos.',
      );
    }
  }

  /** Marca este orçamento como aceite, rejeita os outros do pedido e fecha o pedido. */
  private async closeRequestWithQuote(
    tx: Prisma.TransactionClient,
    requestId: string,
    quoteId: string,
  ) {
    await tx.serviceQuote.update({
      where: { id: quoteId },
      data: { status: ServiceQuoteStatus.ACCEPTED },
    });

    await tx.serviceQuote.updateMany({
      where: {
        requestId,
        id: { not: quoteId },
        status: ServiceQuoteStatus.PENDING,
      },
      data: { status: ServiceQuoteStatus.REJECTED },
    });

    await tx.serviceRequest.update({
      where: { id: requestId },
      data: { status: ServiceRequestStatus.ACCEPTED },
    });
  }

  private validateQuoteTotals(
    dto: CreateServiceQuoteDto,
    request: {
      isUrgent: boolean;
      service: { acceptsUrgent: boolean; urgentSurcharge: unknown };
    },
  ) {
    const amount = Number(dto.amount);
    const total = Number(dto.totalAmount);

    if (request.isUrgent) {
      if (!request.service.acceptsUrgent) {
        throw new BadRequestException(
          'O serviço não aceita pedidos urgentes — não envies majoração.',
        );
      }
      const surchargePct = request.service.urgentSurcharge
        ? Number(request.service.urgentSurcharge)
        : null;
      if (surchargePct === null) {
        throw new BadRequestException(
          'O serviço não tem percentagem de urgência definida.',
        );
      }
      if (dto.urgentSurcharge === undefined) {
        throw new BadRequestException(
          'urgentSurcharge é obrigatório quando o pedido é urgente.',
        );
      }
      const expectedSurcharge = percentOf(amount, surchargePct);
      const providedSurcharge = roundMoney(Number(dto.urgentSurcharge));
      if (providedSurcharge !== expectedSurcharge) {
        throw new BadRequestException(
          `urgentSurcharge inválido. Esperado: ${expectedSurcharge}, recebido: ${providedSurcharge}.`,
        );
      }
      const expectedTotal = roundMoney(amount + expectedSurcharge);
      if (total !== expectedTotal) {
        throw new BadRequestException(
          `totalAmount inválido. Esperado: ${expectedTotal}, recebido: ${total}.`,
        );
      }
      return;
    }

    if (dto.urgentSurcharge !== undefined && Number(dto.urgentSurcharge) > 0) {
      throw new BadRequestException(
        'urgentSurcharge só pode ser definido se o pedido for urgente.',
      );
    }

    if (roundMoney(total - amount) !== 0) {
      throw new BadRequestException(
        'Pedido não urgente: totalAmount deve ser igual a amount.',
      );
    }
  }

  private async generateReceiptNumber(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    for (let attempt = 0; attempt < RECEIPT_MAX_ATTEMPTS; attempt++) {
      const candidate = `ZUNO-${Date.now()}-${crypto
        .randomBytes(3)
        .toString('hex')
        .toUpperCase()}`;
      const collision = await tx.payment.findUnique({
        where: { receiptNumber: candidate },
        select: { id: true },
      });
      if (!collision) {
        return candidate;
      }
    }
    throw new BadRequestException(
      'Não foi possível gerar um número de recibo único.',
    );
  }
}
