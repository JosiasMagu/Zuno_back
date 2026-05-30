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
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { calculatePlatformFee } from '../../../shared/constants/fees';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateServiceQuoteDto } from '../dto/create-service-quote.dto';
import { ServiceQuotePresenter } from '../presenters/service-quote.presenter';

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

const DEFAULT_QUOTE_EXPIRY_HOURS = 48;
const RECEIPT_MAX_ATTEMPTS = 5;

@Injectable()
export class ServiceQuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    providerId: string,
    requestId: string,
    dto: CreateServiceQuoteDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: providerId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Apenas providers podem enviar orçamentos.');
    }

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

    const created = await this.prisma.$transaction(async (tx) => {
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
    });

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
    const initialQuote = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      include: {
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
      },
    });

    if (!initialQuote) {
      throw new NotFoundException('Orçamento não encontrado.');
    }

    if (initialQuote.request.clientId !== clientId) {
      throw new ForbiddenException(
        'Apenas o cliente do pedido pode aceitar este orçamento.',
      );
    }

    if (initialQuote.status !== ServiceQuoteStatus.PENDING) {
      throw new BadRequestException(
        'Apenas orçamentos pendentes podem ser aceites.',
      );
    }

    if (
      initialQuote.expiresAt &&
      initialQuote.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Este orçamento já expirou.');
    }

    if (
      initialQuote.request.status !== ServiceRequestStatus.OPEN &&
      initialQuote.request.status !== ServiceRequestStatus.QUOTED
    ) {
      throw new BadRequestException(
        'Apenas pedidos OPEN ou QUOTED podem ter orçamentos aceites.',
      );
    }

    const serviceAmount = Number(initialQuote.totalAmount);
    const platformFee = calculatePlatformFee(serviceAmount);
    const totalAmount = Number((serviceAmount + platformFee).toFixed(2));

    const result = await this.prisma.$transaction(
      async (tx) => {
        const freshQuote = await tx.serviceQuote.findUnique({
          where: { id: quoteId },
          select: { id: true, status: true, requestId: true, providerId: true },
        });

        if (!freshQuote || freshQuote.status !== ServiceQuoteStatus.PENDING) {
          throw new BadRequestException(
            'O orçamento já não está disponível para aceitação.',
          );
        }

        const freshRequest = await tx.serviceRequest.findUnique({
          where: { id: freshQuote.requestId },
          select: { id: true, clientId: true, status: true, serviceId: true },
        });

        if (!freshRequest) {
          throw new NotFoundException('Pedido não encontrado.');
        }

        if (
          freshRequest.status !== ServiceRequestStatus.OPEN &&
          freshRequest.status !== ServiceRequestStatus.QUOTED
        ) {
          throw new BadRequestException(
            'O pedido já não está disponível para aceitar orçamentos.',
          );
        }

        await tx.serviceQuote.update({
          where: { id: quoteId },
          data: { status: ServiceQuoteStatus.ACCEPTED },
        });

        await tx.serviceQuote.updateMany({
          where: {
            requestId: freshRequest.id,
            id: { not: quoteId },
            status: ServiceQuoteStatus.PENDING,
          },
          data: { status: ServiceQuoteStatus.REJECTED },
        });

        await tx.serviceRequest.update({
          where: { id: freshRequest.id },
          data: { status: ServiceRequestStatus.ACCEPTED },
        });

        const booking = await tx.serviceBooking.create({
          data: {
            clientId: freshRequest.clientId,
            providerId: freshQuote.providerId,
            serviceId: freshRequest.serviceId,
            requestId: freshRequest.id,
            quoteId: freshQuote.id,
            isUrgent: initialQuote.request.isUrgent,
            serviceAmount,
            platformFee,
            totalAmount,
            status: ServiceBookingStatus.PENDING,
          },
        });

        const receiptNumber = await this.generateReceiptNumber(tx);

        const payment = await tx.payment.create({
          data: {
            serviceBookingId: booking.id,
            clientId: freshRequest.clientId,
            providerId: freshQuote.providerId,
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.audit.record({
      action: AuditAction.SERVICE_QUOTE_ACCEPTED,
      actorId: clientId,
      targetType: 'ServiceQuote',
      targetId: quoteId,
      amount: totalAmount,
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
      amount: totalAmount,
      metadata: { serviceBookingId: result.booking.id },
    });

    const accepted = await this.prisma.serviceQuote.findUnique({
      where: { id: quoteId },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

    return {
      message:
        'Orçamento aceite. Reserva e pagamento criados — aguarda confirmação M-Pesa.',
      data: {
        quote: accepted ? ServiceQuotePresenter.toItem(accepted) : null,
        serviceBookingId: result.booking.id,
        paymentId: result.payment.id,
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

    const updated = await this.prisma.serviceQuote.update({
      where: { id: quoteId },
      data: { status: ServiceQuoteStatus.REJECTED },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

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

    const updated = await this.prisma.serviceQuote.update({
      where: { id: quoteId },
      data: { status: ServiceQuoteStatus.WITHDRAWN },
      include: {
        provider: { select: PROVIDER_SELECT },
        request: { select: REQUEST_SELECT },
      },
    });

    return {
      message: 'Orçamento retirado.',
      data: ServiceQuotePresenter.toItem(updated),
    };
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
      const expectedSurcharge = Number(
        ((amount * surchargePct) / 100).toFixed(2),
      );
      const providedSurcharge = Number(Number(dto.urgentSurcharge).toFixed(2));
      if (providedSurcharge !== expectedSurcharge) {
        throw new BadRequestException(
          `urgentSurcharge inválido. Esperado: ${expectedSurcharge}, recebido: ${providedSurcharge}.`,
        );
      }
      const expectedTotal = Number((amount + expectedSurcharge).toFixed(2));
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

    if (Number((total - amount).toFixed(2)) !== 0) {
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
