import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';

import { PrismaService } from '../db/prisma.service';

/** `actorId` das acções que os jobs fazem sozinhos, sem ninguém a pedir. */
export const SYSTEM_ACTOR_ID = 'system';

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
    | 'AuthSession'
    | 'UserVerification'
    | 'Category'
    | 'Payout'
    | 'UnallocatedFunds';
  targetId: string;
  amount?: number | string | Prisma.Decimal | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Regista uma linha de auditoria. Com `tx`, escreve dentro da transacção
   * do chamador e um erro desfaz a operação: um movimento de dinheiro não
   * fica sem registo. Sem `tx`, um erro fica só no log.
   */
  async record(
    entry: AuditEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (tx) {
      await tx.auditLog.create({ data: this.toRow(entry) });
      return;
    }

    try {
      await this.prisma.auditLog.create({
        data: this.toRow(entry),
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${entry.action} on ${entry.targetType}:${entry.targetId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private toRow(entry: AuditEntry): Prisma.AuditLogCreateInput {
    return {
      action: entry.action,
      actorId: entry.actorId,
      targetType: entry.targetType,
      targetId: entry.targetId,
      amount:
        entry.amount === undefined || entry.amount === null
          ? null
          : new Prisma.Decimal(entry.amount as Prisma.Decimal.Value),
      metadata: (entry.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    };
  }
}
