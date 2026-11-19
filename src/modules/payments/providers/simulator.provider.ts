import { randomBytes } from 'crypto';

import {
  CollectionRequest,
  PaymentProvider,
  ProviderEvent,
  ProviderOutcome,
  StatusQuery,
  TransferRequest,
} from './payment-provider';

/**
 * Fornecedor simulado, para desenvolvimento e testes. O desfecho decide-se
 * pelos dois últimos algarismos do número:
 *
 *   01  recusado pelo cliente no telemóvel
 *   02  saldo insuficiente
 *   03  sem resposta; a consulta de estado dá confirmado
 *   04  aceite e à espera; a consulta de estado dá confirmado
 *   05  confirmado, mas com menos 1 MZN do que o pedido
 *   06  sem resposta, para sempre
 *   07  aceite e à espera; a consulta de estado dá expirado
 *   08  confirmado, com uma taxa de 12,50 MZN
 *   outro  confirmado
 *
 * Guarda em memória o que respondeu a cada referência: um pedido repetido
 * com a mesma referência devolve a mesma transacção, como um fornecedor a
 * sério. Recusado em produção (ver env.validation).
 */
export class SimulatorPaymentProvider implements PaymentProvider {
  readonly name = 'simulator' as const;
  readonly collects = true;
  readonly transfers = true;
  readonly ready = true;

  /** O desfecho final de cada referência, para as consultas de estado. */
  private readonly finalOutcomes = new Map<string, ProviderOutcome>();
  /** A primeira resposta a cada referência, para os pedidos repetidos. */
  private readonly firstAnswers = new Map<string, ProviderOutcome>();

  requestCollection(request: CollectionRequest): Promise<ProviderOutcome> {
    return Promise.resolve(this.answer(request));
  }

  sendTransfer(request: TransferRequest): Promise<ProviderOutcome> {
    return Promise.resolve(this.answer(request));
  }

  queryStatus(query: StatusQuery): Promise<ProviderOutcome> {
    return Promise.resolve(
      this.finalOutcomes.get(query.reference) ?? {
        status: 'FAILED',
        code: 'NOT_FOUND',
        reason: 'O fornecedor não conhece esta referência.',
      },
    );
  }

  /**
   * O aviso do simulador: { eventId, reference, status, providerReference,
   * amount, msisdn, code, reason }.
   */
  parseEvent(payload: unknown): ProviderEvent {
    const body = payload as Record<string, unknown> | null;
    const eventId = body?.eventId;
    const status = body?.status;

    if (typeof eventId !== 'string' || !eventId) {
      throw new Error('Aviso sem eventId.');
    }

    const reference =
      typeof body?.reference === 'string' ? body.reference : null;

    if (status === 'CONFIRMED') {
      const providerReference = body?.providerReference;
      const amount = Number(body?.amount);

      if (typeof providerReference !== 'string' || !(amount > 0)) {
        throw new Error('Aviso de confirmação sem referência ou sem valor.');
      }

      return {
        externalId: eventId,
        reference,
        outcome: {
          status: 'CONFIRMED',
          providerReference,
          amount,
          msisdn: typeof body?.msisdn === 'string' ? body.msisdn : undefined,
        },
      };
    }

    if (status === 'FAILED') {
      return {
        externalId: eventId,
        reference,
        outcome: {
          status: 'FAILED',
          code: typeof body?.code === 'string' ? body.code : 'FAILED',
          reason:
            typeof body?.reason === 'string'
              ? body.reason
              : 'O fornecedor recusou a operação.',
        },
      };
    }

    throw new Error(`Estado de aviso desconhecido: ${String(status)}.`);
  }

  private answer(request: {
    reference: string;
    amount: number;
    msisdn: string;
  }): ProviderOutcome {
    const repeated = this.firstAnswers.get(request.reference);
    if (repeated) {
      return repeated;
    }

    const { first, final } = this.scenario(request);
    this.firstAnswers.set(request.reference, first);
    this.finalOutcomes.set(request.reference, final);
    return first;
  }

  private scenario(request: { amount: number; msisdn: string }): {
    first: ProviderOutcome;
    final: ProviderOutcome;
  } {
    const confirmed = (
      extra: { amount?: number; fee?: number } = {},
    ): ProviderOutcome => ({
      status: 'CONFIRMED',
      providerReference: `SIM${randomBytes(5).toString('hex').toUpperCase()}`,
      amount: extra.amount ?? request.amount,
      msisdn: request.msisdn,
      ...(extra.fee !== undefined ? { fee: extra.fee } : {}),
    });
    const same = (outcome: ProviderOutcome) => ({
      first: outcome,
      final: outcome,
    });

    switch (request.msisdn.slice(-2)) {
      case '01':
        return same({
          status: 'FAILED',
          code: 'CUSTOMER_REJECTED',
          reason: 'O cliente recusou o pagamento no telemóvel.',
        });
      case '02':
        return same({
          status: 'FAILED',
          code: 'INSUFFICIENT_FUNDS',
          reason: 'Saldo insuficiente na conta M-Pesa.',
        });
      case '03':
        return {
          first: { status: 'UNKNOWN', reason: 'O fornecedor não respondeu.' },
          final: confirmed(),
        };
      case '04': {
        const final = confirmed();
        return {
          first: {
            status: 'PENDING',
            providerReference:
              final.status === 'CONFIRMED'
                ? final.providerReference
                : undefined,
          },
          final,
        };
      }
      case '05':
        return same(confirmed({ amount: request.amount - 1 }));
      case '06':
        return same({
          status: 'UNKNOWN',
          reason: 'O fornecedor não responde.',
        });
      case '07':
        return {
          first: { status: 'PENDING' },
          final: {
            status: 'FAILED',
            code: 'CUSTOMER_TIMEOUT',
            reason: 'O cliente não confirmou o pagamento a tempo.',
          },
        };
      case '08':
        return same(confirmed({ fee: 12.5 }));
      default:
        return same(confirmed());
    }
  }
}
