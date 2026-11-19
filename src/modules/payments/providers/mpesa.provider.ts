import {
  CollectionRequest,
  PaymentProvider,
  ProviderEvent,
  ProviderOutcome,
  StatusQuery,
  TransferRequest,
} from './payment-provider';

const NOT_READY =
  'O adaptador M-Pesa ainda não está implementado: falta a documentação da API e as credenciais de sandbox. Ver docs/MPESA-INTEGRACAO.md.';

/**
 * Adaptador M-Pesa. Fica por preencher quando chegarem a documentação e as
 * credenciais: o resto do sistema já fala com ele pela porta.
 *
 * Enquanto `ready` for false, a aplicação recusa arrancar com
 * PAYMENTS_PROVIDER=mpesa, por isso estes métodos nunca chegam a correr.
 * Ao implementar:
 * - cada falha de rede ou timeout devolve UNKNOWN, nunca lança;
 * - a nossa `reference` vai no campo de referência do comerciante, para o
 *   fornecedor não cobrar nem enviar duas vezes;
 * - os códigos de erro do fornecedor mapeiam-se para FAILED com um `code`
 *   estável e uma `reason` em português;
 * - a suite de contrato (provider.contract.ts) tem de passar contra o
 *   sandbox antes de pôr `ready = true`.
 */
export class MpesaPaymentProvider implements PaymentProvider {
  readonly name = 'mpesa' as const;
  readonly collects = true;
  readonly transfers = true;
  readonly ready = false;

  requestCollection(request: CollectionRequest): Promise<ProviderOutcome> {
    void request;
    return Promise.reject(new Error(NOT_READY));
  }

  sendTransfer(request: TransferRequest): Promise<ProviderOutcome> {
    void request;
    return Promise.reject(new Error(NOT_READY));
  }

  queryStatus(query: StatusQuery): Promise<ProviderOutcome> {
    void query;
    return Promise.reject(new Error(NOT_READY));
  }

  parseEvent(payload: unknown): ProviderEvent {
    void payload;
    throw new Error(NOT_READY);
  }
}
