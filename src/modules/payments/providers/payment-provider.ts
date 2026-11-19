import { randomBytes } from 'crypto';

/**
 * A porta para o fornecedor de pagamentos (M-Pesa, um agregador, ou o
 * simulador). O resto do sistema só fala com esta interface: trocar de
 * fornecedor é escrever outro adaptador, sem tocar no escrow nem no ledger.
 *
 * Regra de todos os adaptadores: uma falha da rede ou do fornecedor nunca
 * lança. Devolve UNKNOWN, e um job pergunta depois pelo estado. Lançar fica
 * para erros de programação. Ver docs/MPESA-INTEGRACAO.md.
 */

/** Injecção do adaptador escolhido em PAYMENTS_PROVIDER. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentProviderName = 'manual' | 'simulator' | 'mpesa';

/** O que o fornecedor disse de uma operação, já no nosso vocabulário. */
export type ProviderOutcome =
  | {
      status: 'CONFIRMED';
      /** A referência da transacção do lado do fornecedor. */
      providerReference: string;
      /** O valor que mexeu de facto. */
      amount: number;
      /** O número que pagou (cobrança) ou recebeu (envio), quando o diz. */
      msisdn?: string;
      /** O que o fornecedor cobrou pela operação, quando o diz. */
      fee?: number;
      raw?: unknown;
    }
  | { status: 'FAILED'; code: string; reason: string; raw?: unknown }
  | {
      /** Aceite pelo fornecedor e à espera (do cliente, ou de processamento). */
      status: 'PENDING';
      providerReference?: string;
      raw?: unknown;
    }
  | {
      /** Não se sabe se aconteceu: timeout, rede, resposta ilegível. */
      status: 'UNKNOWN';
      reason: string;
      raw?: unknown;
    };

/** Pedir ao cliente que pague, no telemóvel dele. */
export interface CollectionRequest {
  /** A nossa referência. O fornecedor usa-a para não cobrar duas vezes. */
  reference: string;
  amount: number;
  msisdn: string;
  /** O que o cliente vê no pedido de pagamento. */
  description: string;
}

/** Enviar dinheiro para um número: payout, reembolso ou devolução. */
export interface TransferRequest {
  reference: string;
  amount: number;
  msisdn: string;
  description: string;
}

export interface StatusQuery {
  kind: 'COLLECTION' | 'TRANSFER';
  reference: string;
  providerReference?: string | null;
}

/** Um aviso do fornecedor, depois de lido pelo adaptador. */
export interface ProviderEvent {
  /** Identifica o aviso. Um aviso repetido traz o mesmo. */
  externalId: string;
  /** A nossa referência, quando o aviso a traz. */
  reference: string | null;
  outcome: ProviderOutcome;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Cobra no telemóvel do cliente. False no modo manual. */
  readonly collects: boolean;
  /** Envia dinheiro para um número. False no modo manual. */
  readonly transfers: boolean;
  /**
   * O adaptador está acabado e testado contra o fornecedor. A aplicação
   * recusa arrancar com um adaptador que não esteja.
   */
  readonly ready: boolean;

  requestCollection(request: CollectionRequest): Promise<ProviderOutcome>;
  sendTransfer(request: TransferRequest): Promise<ProviderOutcome>;
  queryStatus(query: StatusQuery): Promise<ProviderOutcome>;
  /**
   * Lê um aviso. Lança quando o corpo não é um aviso válido: o aviso fica
   * guardado e não se trata.
   */
  parseEvent(payload: unknown): ProviderEvent;
}

/** O adaptador não faz esta operação (o modo manual não cobra nem envia). */
export class ProviderOperationNotSupported extends Error {
  constructor(provider: PaymentProviderName, operation: string) {
    super(`O fornecedor ${provider} não faz ${operation}.`);
  }
}

/** Prefixos das nossas referências, para se ver de onde vem cada uma. */
const REFERENCE_PREFIX = {
  COLLECTION: 'ZC',
  PAYOUT: 'ZP',
  RETURN: 'ZR',
  MANUAL: 'ZM',
} as const;

/**
 * Uma referência nossa, nova: duas letras e catorze caracteres hexadecimais
 * em maiúsculas. É curta e só tem letras e algarismos, que é o que os
 * fornecedores costumam aceitar. O limite exacto confirma-se com cada um.
 */
export function newProviderReference(
  kind: keyof typeof REFERENCE_PREFIX,
): string {
  return `${REFERENCE_PREFIX[kind]}${randomBytes(7).toString('hex').toUpperCase()}`;
}

/**
 * Chama o adaptador sem deixar escapar um erro. Um adaptador não devia
 * lançar, mas se lançar a operação fica UNKNOWN e o job pergunta depois:
 * perder a operação era pior do que perguntar por ela.
 */
export async function callProvider(
  call: () => Promise<ProviderOutcome>,
): Promise<ProviderOutcome> {
  try {
    return await call();
  } catch (error) {
    return {
      status: 'UNKNOWN',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
