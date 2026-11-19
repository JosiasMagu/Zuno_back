import {
  assertFourEyes,
  assertNotOwnPayout,
  assertNotPartyToPayment,
  assertNotPayee,
  payoutAutoMaxAmount,
  payoutNeedsApproval,
} from './money-controls';

const ADMIN_ID = 'admin-1';

describe('assertNotPartyToPayment', () => {
  it('deixa um admin confirmar o pagamento de uma reserva alheia', () => {
    expect(() =>
      assertNotPartyToPayment(ADMIN_ID, { clientId: 'c', ownerId: 'o' }),
    ).not.toThrow();
  });

  it.each([
    ['cliente', { clientId: ADMIN_ID, ownerId: 'o' }],
    ['dono', { clientId: 'c', ownerId: ADMIN_ID }],
  ])('recusa quando o admin é o %s da reserva', (_role, payment) => {
    expect(() => assertNotPartyToPayment(ADMIN_ID, payment)).toThrow(
      'Um admin não decide sobre o dinheiro de uma reserva em que é cliente ou dono. Pede a outro admin.',
    );
  });
});

describe('assertNotPayee', () => {
  it('recusa a quem recebe o pagamento, mesmo sendo admin', () => {
    expect(() => assertNotPayee(ADMIN_ID, { ownerId: ADMIN_ID })).toThrow(
      'Quem recebe este pagamento não o pode liberar, mesmo sendo admin.',
    );
  });

  it('deixa o cliente ou outro admin', () => {
    expect(() => assertNotPayee('cliente', { ownerId: 'dono' })).not.toThrow();
  });
});

describe('payoutAutoMaxAmount', () => {
  const reader = (value: unknown) => ({ get: () => value }) as never;

  it('usa o valor da política quando a variável não existe', () => {
    expect(payoutAutoMaxAmount(reader(undefined))).toBe(5000);
    expect(payoutAutoMaxAmount(reader(''))).toBe(5000);
  });

  it('usa o valor configurado', () => {
    expect(payoutAutoMaxAmount(reader('0'))).toBe(0);
    expect(payoutAutoMaxAmount(reader(12000))).toBe(12000);
  });
});

describe('payoutNeedsApproval', () => {
  const base = { status: 'PENDING', amount: 6000, approvedAt: null };

  it('pede aprovação acima do valor automático', () => {
    expect(payoutNeedsApproval(base, 5000)).toBe(true);
  });

  it('não pede no valor automático nem abaixo dele', () => {
    expect(payoutNeedsApproval({ ...base, amount: 5000 }, 5000)).toBe(false);
  });

  it('não pede depois de aprovado nem fora de PENDING', () => {
    expect(payoutNeedsApproval({ ...base, approvedAt: new Date() }, 5000)).toBe(
      false,
    );
    expect(payoutNeedsApproval({ ...base, status: 'EXECUTED' }, 5000)).toBe(
      false,
    );
  });
});

describe('assertNotOwnPayout', () => {
  it('recusa um payout para o próprio admin', () => {
    expect(() =>
      assertNotOwnPayout(ADMIN_ID, { recipientId: ADMIN_ID }),
    ).toThrow('Um admin não aprova nem executa um payout para si próprio.');
  });

  it('deixa um payout para outra conta', () => {
    expect(() =>
      assertNotOwnPayout(ADMIN_ID, { recipientId: 'outra' }),
    ).not.toThrow();
  });
});

describe('assertFourEyes', () => {
  it('com quatro olhos, recusa a quem confirmou a entrada', () => {
    expect(() =>
      assertFourEyes(true, ADMIN_ID, { heldById: ADMIN_ID }),
    ).toThrow(/Quem confirmou a entrada deste dinheiro/);
  });

  it('com quatro olhos, deixa outro admin', () => {
    expect(() =>
      assertFourEyes(true, ADMIN_ID, { heldById: 'outro-admin' }),
    ).not.toThrow();
  });

  it('com quatro olhos, não prende um pagamento confirmado pelo fornecedor', () => {
    expect(() =>
      assertFourEyes(true, ADMIN_ID, { heldById: 'system' }),
    ).not.toThrow();
  });

  it('sem quatro olhos, deixa o mesmo admin', () => {
    expect(() =>
      assertFourEyes(false, ADMIN_ID, { heldById: ADMIN_ID }),
    ).not.toThrow();
  });
});
