import { ConfigService } from '@nestjs/config';

import { ManualPaymentProvider } from './manual.provider';
import { MpesaPaymentProvider } from './mpesa.provider';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  PaymentProviderName,
} from './payment-provider';
import { SimulatorPaymentProvider } from './simulator.provider';

/**
 * Escolhe o adaptador pela variável PAYMENTS_PROVIDER (manual por omissão).
 * Recusa o simulador em produção e qualquer adaptador por acabar: é melhor a
 * aplicação não arrancar do que receber dinheiro por um caminho a meio.
 */
export function createPaymentProvider(
  name: PaymentProviderName,
  nodeEnv: string | undefined,
): PaymentProvider {
  const provider = buildProvider(name);

  if (provider.name === 'simulator' && nodeEnv === 'production') {
    throw new Error(
      'PAYMENTS_PROVIDER=simulator não é aceite em produção: dá pagamentos como recebidos sem dinheiro nenhum.',
    );
  }

  if (!provider.ready) {
    throw new Error(
      `O adaptador de pagamentos ${provider.name} ainda não está pronto. Usa PAYMENTS_PROVIDER=manual até estar.`,
    );
  }

  return provider;
}

function buildProvider(name: PaymentProviderName): PaymentProvider {
  switch (name) {
    case 'simulator':
      return new SimulatorPaymentProvider();
    case 'mpesa':
      return new MpesaPaymentProvider();
    case 'manual':
    default:
      return new ManualPaymentProvider();
  }
}

/** Provider do Nest para o adaptador escolhido no ambiente. */
export const paymentProviderFactory = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PaymentProvider =>
    createPaymentProvider(
      (config.get<string>('PAYMENTS_PROVIDER') ??
        'manual') as PaymentProviderName,
      config.get<string>('NODE_ENV'),
    ),
};
