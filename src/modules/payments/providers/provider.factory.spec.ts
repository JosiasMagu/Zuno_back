import { createPaymentProvider } from './provider.factory';

describe('createPaymentProvider', () => {
  it('fica no modo manual por omissão', () => {
    const provider = createPaymentProvider(
      undefined as unknown as 'manual',
      'production',
    );

    expect(provider.name).toBe('manual');
    expect(provider.collects).toBe(false);
    expect(provider.transfers).toBe(false);
  });

  it('aceita o simulador fora de produção', () => {
    expect(createPaymentProvider('simulator', 'development').name).toBe(
      'simulator',
    );
  });

  it('recusa o simulador em produção', () => {
    expect(() => createPaymentProvider('simulator', 'production')).toThrow(
      /simulator não é aceite em produção/,
    );
  });

  it('recusa o adaptador M-Pesa enquanto não estiver pronto, em qualquer ambiente', () => {
    expect(() => createPaymentProvider('mpesa', 'development')).toThrow(
      /mpesa ainda não está pronto/,
    );
  });
});
