import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UnallocatedReason } from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';

import { SYSTEM_ACTOR_ID } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { describeError } from '../../../shared/scheduling/process-due';
import {
  PAYMENT_PROVIDER,
  ProviderEvent as ParsedEvent,
} from '../providers/payment-provider';
import type { PaymentProvider } from '../providers/payment-provider';
import { ProviderOperationsService } from './provider-operations.service';
import { UnallocatedFundsService } from './unallocated-funds.service';

/** Um aviso que falhou tantas vezes fica parado, para alguém olhar. */
const MAX_ATTEMPTS = 20;
const BATCH_SIZE = 50;

/** Compara dois segredos sem deixar o tempo da comparação dizer nada. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Avisos do fornecedor (webhooks). Cada aviso fica guardado tal como chegou
 * antes de ser tratado, por isso um erro a meio não o perde: o job volta a
 * tratá-lo. Um aviso repetido não entra duas vezes. A resposta ao fornecedor
 * sai logo, trate-se o aviso ou não.
 */
@Injectable()
export class ProviderEventsService {
  private readonly logger = new Logger(ProviderEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly operations: ProviderOperationsService,
    private readonly unallocated: UnallocatedFundsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async receive(
    providerName: string,
    token: string | undefined,
    payload: unknown,
  ) {
    if (
      providerName !== this.provider.name ||
      (!this.provider.collects && !this.provider.transfers)
    ) {
      throw new NotFoundException(
        'Este fornecedor de pagamentos não está ligado.',
      );
    }

    const secret = this.config.get<string>('PAYMENTS_WEBHOOK_SECRET');
    if (!secret || !token || !sameSecret(token, secret)) {
      throw new UnauthorizedException('Aviso recusado.');
    }

    let parsed: ParsedEvent;
    try {
      parsed = this.provider.parseEvent(payload);
    } catch (error) {
      throw new BadRequestException(`Aviso inválido: ${describeError(error)}`);
    }

    let eventId: string;
    try {
      const event = await this.prisma.providerEvent.create({
        data: {
          provider: this.provider.name,
          externalId: parsed.externalId,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      eventId = event.id;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { message: 'Aviso já recebido.', data: { duplicate: true } };
      }
      throw error;
    }

    await this.process(eventId);

    return { message: 'Aviso recebido.', data: { duplicate: false } };
  }

  /** Trata os avisos que ficaram por tratar. Chamado pelo scheduler. */
  async processPending(): Promise<number> {
    const events = await this.prisma.providerEvent.findMany({
      where: {
        provider: this.provider.name,
        processedAt: null,
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { receivedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });

    for (const event of events) {
      await this.process(event.id);
    }

    return events.length;
  }

  /** Trata um aviso. Um erro fica registado no aviso e o job tenta depois. */
  async process(eventId: string): Promise<void> {
    const event = await this.prisma.providerEvent.findUnique({
      where: { id: eventId },
    });
    if (!event || event.processedAt) {
      return;
    }

    try {
      const parsed = this.provider.parseEvent(event.payload);
      await this.apply(parsed);

      await this.prisma.providerEvent.update({
        where: { id: eventId },
        data: {
          processedAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Aviso ${event.externalId} do fornecedor ${event.provider} falhou: ${describeError(error)}`,
      );
      await this.prisma.providerEvent.update({
        where: { id: eventId },
        data: { attempts: { increment: 1 }, lastError: describeError(error) },
      });
    }
  }

  private async apply(parsed: ParsedEvent): Promise<void> {
    const operation = parsed.reference
      ? await this.prisma.providerOperation.findUnique({
          where: { reference: parsed.reference },
          select: { id: true, kind: true },
        })
      : null;

    if (operation) {
      await this.operations.route(operation, parsed.outcome);
      return;
    }

    // Dinheiro que entrou sem nenhuma operação nossa fica por atribuir,
    // salvo se o admin já o contou (num pagamento ou por atribuir).
    const { outcome } = parsed;
    if (outcome.status === 'CONFIRMED') {
      await runSerializable(
        this.prisma,
        async (tx) => {
          if (
            await this.unallocated.isAccounted(tx, outcome.providerReference)
          ) {
            return null;
          }
          return this.unallocated.record(tx, {
            provider: this.provider.name,
            providerReference: outcome.providerReference,
            amount: outcome.amount,
            payerMsisdn: outcome.msisdn ?? null,
            paymentId: null,
            reason: UnallocatedReason.UNKNOWN_REFERENCE,
            recordedById: SYSTEM_ACTOR_ID,
            note: parsed.reference
              ? `Aviso com a referência ${parsed.reference}, que não existe.`
              : 'Aviso sem referência nossa.',
          });
        },
        () =>
          new BadRequestException(
            'Outro pedido registou este dinheiro ao mesmo tempo.',
          ),
      );
    }
  }
}
