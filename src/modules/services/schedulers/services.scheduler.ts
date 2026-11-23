import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { ServiceQuoteStatus, ServiceRequestStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { describeError } from '../../../shared/scheduling/process-due';
import { ServiceBookingsService } from '../services/service-bookings.service';
import { Job } from '../../../shared/scheduling/job.decorator';

@Injectable()
export class ServicesScheduler {
  private readonly logger = new Logger(ServicesScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly serviceBookings: ServiceBookingsService,
  ) {}

  /**
   * Expira as reservas de serviço que passaram o prazo sem o dinheiro entrar
   * no escrow, para o provider não ficar preso a um trabalho que não foi pago.
   */
  @Job(CronExpression.EVERY_10_MINUTES, 'services-expire-unpaid')
  async expireUnpaidBookings() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    try {
      const expired = await this.serviceBookings.expireUnpaid();
      if (expired > 0) {
        this.logger.log(
          `Expiração: ${expired} reserva(s) de serviço por pagar.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expiração de reservas de serviço falhou: ${describeError(error)}`,
      );
    }
  }

  @Job(CronExpression.EVERY_5_MINUTES, 'services-expire-stale')
  async expireStaleEntities() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const now = new Date();

    const expiredQuotes = await this.prisma.serviceQuote.updateMany({
      where: {
        status: ServiceQuoteStatus.PENDING,
        expiresAt: { lt: now },
      },
      data: { status: ServiceQuoteStatus.EXPIRED },
    });

    const expiredRequests = await this.prisma.serviceRequest.updateMany({
      where: {
        status: {
          in: [ServiceRequestStatus.OPEN, ServiceRequestStatus.QUOTED],
        },
        expiresAt: { lt: now },
      },
      data: { status: ServiceRequestStatus.EXPIRED },
    });

    if (expiredQuotes.count > 0 || expiredRequests.count > 0) {
      this.logger.log(
        `Expirados: ${expiredQuotes.count} orçamentos, ${expiredRequests.count} pedidos.`,
      );
    }
  }
}
