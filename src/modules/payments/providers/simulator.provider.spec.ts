import { callProvider, newProviderReference } from './payment-provider';
import { describePaymentProviderContract } from './payment-provider.contract';
import { SimulatorPaymentProvider } from './simulator.provider';

describePaymentProviderContract(
  'simulador',
  () => new SimulatorPaymentProvider(),
  {
    confirmMsisdn: '+258840000900',
    rejectMsisdn: '+258840000901',
    amount: 100,
  },
);

describe('SimulatorPaymentProvider', () => {
  let simulator: SimulatorPaymentProvider;

  beforeEach(() => {
    simulator = new SimulatorPaymentProvider();
  });

  const collect = (
    msisdn: string,
    reference = newProviderReference('COLLECTION'),
  ) =>
    simulator.requestCollection({
      reference,
      amount: 9950,
      msisdn,
      description: 'Teste',
    });

  it.each([
    ['01', 'FAILED'],
    ['02', 'FAILED'],
    ['03', 'UNKNOWN'],
    ['04', 'PENDING'],
    ['05', 'CONFIRMED'],
    ['06', 'UNKNOWN'],
    ['07', 'PENDING'],
    ['08', 'CONFIRMED'],
    ['99', 'CONFIRMED'],
  ])('um número terminado em %s responde %s', async (ending, status) => {
    const outcome = await collect(`+2588400000${ending}`);

    expect(outcome.status).toBe(status);
  });

  it.each([
    ['03', 'CONFIRMED'],
    ['04', 'CONFIRMED'],
    ['06', 'UNKNOWN'],
    ['07', 'FAILED'],
  ])(
    'a consulta de um número terminado em %s dá %s',
    async (ending, status) => {
      const reference = newProviderReference('COLLECTION');
      await collect(`+2588400000${ending}`, reference);

      const outcome = await simulator.queryStatus({
        kind: 'COLLECTION',
        reference,
      });

      expect(outcome.status).toBe(status);
    },
  );

  it('confirma com menos 1 MZN num número terminado em 05', async () => {
    const outcome = await collect('+258840000005');

    expect(outcome).toMatchObject({ status: 'CONFIRMED', amount: 9949 });
  });

  it('diz a taxa num número terminado em 08', async () => {
    const outcome = await collect('+258840000008');

    expect(outcome).toMatchObject({ status: 'CONFIRMED', fee: 12.5 });
  });

  it('lê os seus avisos de confirmação e de falha', () => {
    expect(
      simulator.parseEvent({
        eventId: 'ev-1',
        reference: 'ZC123',
        status: 'CONFIRMED',
        providerReference: 'SIMABC',
        amount: 9950,
        msisdn: '+258840000004',
      }),
    ).toEqual({
      externalId: 'ev-1',
      reference: 'ZC123',
      outcome: {
        status: 'CONFIRMED',
        providerReference: 'SIMABC',
        amount: 9950,
        msisdn: '+258840000004',
      },
    });

    expect(
      simulator.parseEvent({
        eventId: 'ev-2',
        reference: 'ZC123',
        status: 'FAILED',
      }),
    ).toMatchObject({ outcome: { status: 'FAILED', code: 'FAILED' } });
  });

  it.each([
    ['sem eventId', { status: 'CONFIRMED' }],
    [
      'uma confirmação sem valor',
      { eventId: 'e', status: 'CONFIRMED', providerReference: 'X' },
    ],
    ['um estado desconhecido', { eventId: 'e', status: 'TALVEZ' }],
  ])('recusa um aviso %s', (_label, payload) => {
    expect(() => simulator.parseEvent(payload)).toThrow();
  });
});

describe('callProvider', () => {
  it('troca um erro do adaptador por UNKNOWN, para a operação não se perder', async () => {
    const outcome = await callProvider(() =>
      Promise.reject(new Error('ligação recusada')),
    );

    expect(outcome).toEqual({ status: 'UNKNOWN', reason: 'ligação recusada' });
  });
});

describe('newProviderReference', () => {
  it('dá referências curtas, só com letras e algarismos, e diferentes', () => {
    const references = new Set(
      Array.from({ length: 200 }, () => newProviderReference('COLLECTION')),
    );

    expect(references.size).toBe(200);
    for (const reference of references) {
      expect(reference).toMatch(/^ZC[0-9A-F]{14}$/);
    }
  });
});
