import {
  PaymentProvider,
  ProviderEvent,
  ProviderOperationNotSupported,
  ProviderOutcome,
} from './payment-provider';

/**
 * O modo de hoje: o cliente paga para o número da plataforma e declara a
 * referência, o admin confirma pelo extracto (mark-held) e envia os payouts
 * à mão. Não cobra, não envia e não recebe avisos.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual' as const;
  readonly collects = false;
  readonly transfers = false;
  readonly ready = true;

  requestCollection(): Promise<ProviderOutcome> {
    return Promise.reject(
      new ProviderOperationNotSupported(this.name, 'cobranças'),
    );
  }

  sendTransfer(): Promise<ProviderOutcome> {
    return Promise.reject(
      new ProviderOperationNotSupported(this.name, 'envios'),
    );
  }

  queryStatus(): Promise<ProviderOutcome> {
    return Promise.reject(
      new ProviderOperationNotSupported(this.name, 'consultas de estado'),
    );
  }

  parseEvent(): ProviderEvent {
    throw new ProviderOperationNotSupported(this.name, 'avisos');
  }
}
