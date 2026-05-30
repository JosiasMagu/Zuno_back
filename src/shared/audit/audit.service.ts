import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';

import { PrismaService } from '../db/prisma.service';

export interface AuditEntry {
  action: AuditAction;
  actorId: string;
  targetType:
    | 'Payment'
    | 'Dispute'
    | 'Booking'
    | 'Equipment'
    | 'Service'
    | 'ServiceBooking'
    | 'ServiceRequest'
    | 'ServiceQuote'
    | 'User'
    | 'UserVerification'
    | 'Category';
  targetId: string;
  amount?: number | string | Prisma.Decimal | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId,
          targetType: entry.targetType,
          targetId: entry.targetId,
          amount:
            entry.amount === undefined || entry.amount === null
              ? null
              : new Prisma.Decimal(entry.amount as Prisma.Decimal.Value),
          metadata:
            (entry.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${entry.action} on ${entry.targetType}:${entry.targetId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
