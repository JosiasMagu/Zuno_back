import {
  PAYOUT_STALE_HOURS,
  PROVIDER_OPERATION_STUCK_HOURS,
  UNALLOCATED_FUNDS_ALERT_HOURS,
} from '../../shared/constants/policy';
import {
  alertCutoffs,
  openUnallocatedAlert,
  ReconciliationAlertKind,
  stalePayoutAlert,
  stuckOperationAlert,
} from './reconciliation-alerts';

const NOW = new Date('2030-06-10T12:00:00.000Z');
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe('alertCutoffs', () => {
  it('conta cada prazo da política para trás, a partir de agora', () => {
    expect(alertCutoffs(NOW)).toEqual({
      operations: hoursAgo(PROVIDER_OPERATION_STUCK_HOURS),
      payouts: hoursAgo(PAYOUT_STALE_HOURS),
      unallocated: hoursAgo(UNALLOCATED_FUNDS_ALERT_HOURS),
    });
  });
});

describe('stuckOperationAlert', () => {
  it('diz que operação está presa, há quanto tempo e onde confirmar', () => {
    const alert = stuckOperationAlert(
      {
        id: 'op-1',
        provider: 'mpesa',
        kind: 'PAYOUT',
        status: 'UNKNOWN',
        reference: 'ZP0123456789ABCD',
        amount: 1800,
        createdAt: hoursAgo(7),
      },
      NOW,
    );

    expect(alert).toEqual({
      kind: ReconciliationAlertKind.OPERATION_STUCK,
      targetType: 'ProviderOperation',
      targetId: 'op-1',
      since: hoursAgo(7),
      amount: 1800,
      detail:
        'A operação PAYOUT ZP0123456789ABCD (mpesa) está UNKNOWN há 7 h. Confirma o estado no portal do fornecedor.',
    });
  });
});

describe('stalePayoutAlert', () => {
  const payout = {
    id: 'payout-1',
    kind: 'PROVIDER_PAYOUT',
    amount: 6000,
    createdAt: hoursAgo(50),
  };

  it('distingue o payout que espera aprovação', () => {
    expect(stalePayoutAlert({ ...payout, needsApproval: true }, NOW)).toEqual(
      expect.objectContaining({
        kind: ReconciliationAlertKind.PAYOUT_STALE,
        targetType: 'Payout',
        detail:
          'O payout PROVIDER_PAYOUT de 6000.00 MZN está à espera de aprovação há 50 h.',
      }),
    );
  });

  it('do que só falta executar', () => {
    expect(
      stalePayoutAlert({ ...payout, needsApproval: false }, NOW).detail,
    ).toBe(
      'O payout PROVIDER_PAYOUT de 6000.00 MZN está por executar há 50 h.',
    );
  });
});

describe('openUnallocatedAlert', () => {
  it('diz quanto, porquê e a referência para encontrar no extracto', () => {
    const alert = openUnallocatedAlert(
      {
        id: 'funds-1',
        reason: 'AMOUNT_MISMATCH',
        providerReference: 'AB12CD34EF',
        amount: 2000,
        createdAt: hoursAgo(49),
      },
      NOW,
    );

    expect(alert).toEqual({
      kind: ReconciliationAlertKind.UNALLOCATED_OPEN,
      targetType: 'UnallocatedFunds',
      targetId: 'funds-1',
      since: hoursAgo(49),
      amount: 2000,
      detail:
        '2000.00 MZN por atribuir (AMOUNT_MISMATCH, referência AB12CD34EF) há 49 h sem devolução.',
    });
  });
});
