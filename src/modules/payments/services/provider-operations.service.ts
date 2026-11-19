import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ProviderOperation,
  ProviderOperationKind,
  ProviderOperationStatus,
} from '@prisma/client';

import { PROVIDER_STATUS_CHECK_AFTER_SECONDS } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import {
  describeError,
  processDue,
} from '../../../shared/scheduling/process-due';
import {
  callProvider,
  PAYMENT_PROVIDER,
  ProviderOutcome,
} from '../providers/payment-provider';
import type { PaymentProvider } from '../providers/payment-provider';
import { CollectionsService } from './collections.service';
import { PayoutDispatcher } from './payout-dispatcher.service';
import { UnallocatedFundsService } from './unallocated-funds.service';

const BATCH_SIZE = 50;
const SECOND_MS = 1000;
/** O intervalo entre consultas dobra a cada tentativa, até uma hora. */
const MAX_BACKOFF_MS = 60 * 60 * SECOND_MS;

/**
 * Quanto esperar antes de voltar a perguntar ao fornecedor por uma operação.
 * Começa nos segundos de PROVIDER_STATUS_CHECK_AFTER_SECONDS e dobra a cada
 * consulta, para uma operação presa não encher o fornecedor de pedidos.
 */
export function nextCheckAt(operation: {
  checks: number;
  lastCheckedAt: Date | null;
  updatedAt: Date;
}): Date {
  const base = PROVIDER_STATUS_CHECK_AFTER_SECONDS * SECOND_MS;
  const wait = Math.min(base * 2 ** operation.checks, MAX_BACKOFF_MS);
  const from = operation.lastCheckedAt ?? operation.updatedAt;

  return new Date(from.getTime() + wait);
}

/**
 * As operações no fornecedor que ainda não têm resposta final. Pergunta-lhe
 * pelo estado e encaminha cada desfecho para quem trata daquele tipo de
 * operação: cobranças, envios ou devoluções.
 */
@Injectable()
export class ProviderOperationsService {
  private readonly logger = new Logger(ProviderOperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionsService,
    private readonly dispatcher: PayoutDispatcher,
    private readonly unallocated: UnallocatedFundsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Encaminha o desfecho de uma operação para quem a trata. */
  async route(
    operation: Pick<ProviderOperation, 'id' | 'kind'>,
    outcome: ProviderOutcome,
  ): Promise<void> {
    switch (operation.kind) {
      case ProviderOperationKind.COLLECTION:
        return this.collections.settle(operation.id, outcome);
      case ProviderOperationKind.PAYOUT:
        return this.dispatcher.settle(operation.id, outcome);
      case ProviderOperationKind.RETURN:
        return this.unallocated.settleReturn(operation.id, outcome);
    }
  }

  /**
   * Pergunta pelo estado das operações sem resposta. Só as deste
   * fornecedor: uma operação de outro (depois de uma troca de PAYMENTS_
   * PROVIDER) fica para a reconciliação apontar.
   */
  async pollDue(now: Date = new Date()): Promise<number> {
    if (!this.provider.collects && !this.provider.transfers) {
      return 0;
    }

    const quietSince = new Date(
      now.getTime() - PROVIDER_STATUS_CHECK_AFTER_SECONDS * SECOND_MS,
    );

    return processDue({
      fetchBatch: (seenIds) =>
        this.prisma.providerOperation.findMany({
          where: {
            id: { notIn: seenIds },
            provider: this.provider.name,
            status: {
              in: [
                ProviderOperationStatus.REQUESTED,
                ProviderOperationStatus.PENDING,
                ProviderOperationStatus.UNKNOWN,
              ],
            },
            updatedAt: { lte: quietSince },
          },
          orderBy: { updatedAt: 'asc' },
          take: BATCH_SIZE,
        }),
      handle: async (operation) => {
        if (nextCheckAt(operation) > now) {
          return;
        }
        await this.check(operation);
      },
      onFailure: (operation, error) =>
        this.logger.warn(
          `Consulta da operação ${operation.reference} falhou: ${describeError(error)}`,
        ),
    });
  }

  /** Pergunta ao fornecedor por uma operação e aplica a resposta. */
  async check(operation: ProviderOperation): Promise<void> {
    const outcome = await callProvider(() =>
      this.provider.queryStatus({
        kind:
          operation.kind === ProviderOperationKind.COLLECTION
            ? 'COLLECTION'
            : 'TRANSFER',
        reference: operation.reference,
        providerReference: operation.providerReference,
      }),
    );

    await this.prisma.providerOperation.update({
      where: { id: operation.id },
      data: { checks: { increment: 1 }, lastCheckedAt: new Date() },
    });

    await this.route(operation, outcome);
  }
}
