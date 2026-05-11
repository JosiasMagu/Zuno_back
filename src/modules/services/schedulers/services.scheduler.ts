import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ServiceQuoteStatus, ServiceRequestStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';

@Injectable()
export class ServicesScheduler {
  private readonly logger = new Logger(ServicesScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'services-expire-stale' })
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
