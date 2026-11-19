import {
  newProviderReference,
  PaymentProvider,
  ProviderOutcome,
} from './payment-provider';

/** Números que levam o adaptador em teste a cada desfecho. */
export interface ContractSamples {
  /** Um número com que a cobrança e o envio são confirmados. */
  confirmMsisdn: string;
  /** Um número com que a cobrança é recusada, se o fornecedor permitir. */
  rejectMsisdn?: string;
  /** Valor pequeno para os testes, que num sandbox também custa saldo. */
  amount: number;
}

const SETTLED: ProviderOutcome['status'][] = [
  'CONFIRMED',
  'FAILED',
  'PENDING',
  'UNKNOWN',
];

/**
 * O contrato que qualquer adaptador de pagamentos cumpre. Corre contra o
 * simulador em todos os testes, e contra o sandbox do fornecedor real quando
 * houver credenciais. Um adaptador só fica `ready` depois de o passar.
 */
export function describePaymentProviderContract(
  label: string,
  makeProvider: () => PaymentProvider,
  samples: ContractSamples,
) {
  describe(`contrato de pagamentos: ${label}`, () => {
    let provider: PaymentProvider;

    beforeEach(() => {
      provider = makeProvider();
    });

    const collect = (
      msisdn: string,
      reference = newProviderReference('COLLECTION'),
    ) =>
      provider.requestCollection({
        reference,
        amount: samples.amount,
        msisdn,
        description: 'Teste de contrato ZUNO',
      });

    it('responde a uma cobrança com um desfecho conhecido, sem lançar', async () => {
      const outcome = await collect(samples.confirmMsisdn);

      expect(SETTLED).toContain(outcome.status);
    });

    it('uma cobrança confirmada traz a referência do fornecedor e o valor', async () => {
      const outcome = await collect(samples.confirmMsisdn);

      if (outcome.status === 'CONFIRMED') {
        expect(outcome.providerReference).toEqual(expect.any(String));
        expect(outcome.providerReference.length).toBeGreaterThan(0);
        expect(outcome.amount).toBe(samples.amount);
      }
    });

    it('um pedido repetido com a mesma referência não cobra outra vez', async () => {
      const reference = newProviderReference('COLLECTION');

      const first = await collect(samples.confirmMsisdn, reference);
      const second = await collect(samples.confirmMsisdn, reference);

      if (first.status === 'CONFIRMED' && second.status === 'CONFIRMED') {
        expect(second.providerReference).toBe(first.providerReference);
      }
    });

    it('a consulta de uma referência que o fornecedor não conhece não lança', async () => {
      const outcome = await provider.queryStatus({
        kind: 'COLLECTION',
        reference: newProviderReference('COLLECTION'),
      });

      expect(['FAILED', 'UNKNOWN']).toContain(outcome.status);
    });

    it('a consulta de uma cobrança feita devolve o mesmo desfecho final', async () => {
      const reference = newProviderReference('COLLECTION');
      await collect(samples.confirmMsisdn, reference);

      const outcome = await provider.queryStatus({
        kind: 'COLLECTION',
        reference,
      });

      expect(SETTLED).toContain(outcome.status);
    });

    it('um envio responde com um desfecho conhecido, sem lançar', async () => {
      const outcome = await provider.sendTransfer({
        reference: newProviderReference('PAYOUT'),
        amount: samples.amount,
        msisdn: samples.confirmMsisdn,
        description: 'Teste de contrato ZUNO',
      });

      expect(SETTLED).toContain(outcome.status);
    });

    if (samples.rejectMsisdn) {
      const rejectMsisdn = samples.rejectMsisdn;

      it('uma recusa traz um código e uma razão', async () => {
        const outcome = await collect(rejectMsisdn);

        expect(outcome.status).toBe('FAILED');
        if (outcome.status === 'FAILED') {
          expect(outcome.code.length).toBeGreaterThan(0);
          expect(outcome.reason.length).toBeGreaterThan(0);
        }
      });
    }

    it('recusa ler um aviso que não é um aviso', () => {
      expect(() => provider.parseEvent({ isto: 'não é um aviso' })).toThrow();
    });
  });
}
