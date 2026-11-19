import {
  PROVIDER_OPERATION_STUCK_HOURS,
  PAYOUT_STALE_HOURS,
  UNALLOCATED_FUNDS_ALERT_HOURS,
} from '../../shared/constants/policy';

/**
 * O que está parado tempo demais à espera de alguém. Ao contrário de uma
 * divergência, o dinheiro bate certo: só não andou. Cada alerta pede que um
 * admin vá ver.
 */
export enum ReconciliationAlertKind {
  /** Uma operação no fornecedor continua sem resposta final. */
  OPERATION_STUCK = 'OPERATION_STUCK',
  /** Um payout continua por executar. */
  PAYOUT_STALE = 'PAYOUT_STALE',
  /** Dinheiro por atribuir continua por devolver a quem pagou. */
  UNALLOCATED_OPEN = 'UNALLOCATED_OPEN',
}

export interface ReconciliationAlert {
  kind: ReconciliationAlertKind;
  targetType: 'ProviderOperation' | 'Payout' | 'UnallocatedFunds';
  targetId: string;
  since: Date;
  amount: number;
  detail: string;
}

const HOUR_MS = 60 * 60 * 1000;

/** A partir de quando cada coisa parada passa a alerta. */
export function alertCutoffs(now: Date) {
  const before = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);

  return {
    operations: before(PROVIDER_OPERATION_STUCK_HOURS),
    payouts: before(PAYOUT_STALE_HOURS),
    unallocated: before(UNALLOCATED_FUNDS_ALERT_HOURS),
  };
}

const mzn = (value: number) => `${value.toFixed(2)} MZN`;

function hoursSince(since: Date, now: Date): number {
  return Math.floor((now.getTime() - since.getTime()) / HOUR_MS);
}

export function stuckOperationAlert(
  operation: {
    id: string;
    provider: string;
    kind: string;
    status: string;
    reference: string;
    amount: number;
    createdAt: Date;
  },
  now: Date,
): ReconciliationAlert {
  return {
    kind: ReconciliationAlertKind.OPERATION_STUCK,
    targetType: 'ProviderOperation',
    targetId: operation.id,
    since: operation.createdAt,
    amount: operation.amount,
    detail: `A operação ${operation.kind} ${operation.reference} (${operation.provider}) está ${operation.status} há ${hoursSince(operation.createdAt, now)} h. Confirma o estado no portal do fornecedor.`,
  };
}

export function stalePayoutAlert(
  payout: {
    id: string;
    kind: string;
    amount: number;
    createdAt: Date;
    needsApproval: boolean;
  },
  now: Date,
): ReconciliationAlert {
  const waiting = payout.needsApproval
    ? 'à espera de aprovação'
    : 'por executar';

  return {
    kind: ReconciliationAlertKind.PAYOUT_STALE,
    targetType: 'Payout',
    targetId: payout.id,
    since: payout.createdAt,
    amount: payout.amount,
    detail: `O payout ${payout.kind} de ${mzn(payout.amount)} está ${waiting} há ${hoursSince(payout.createdAt, now)} h.`,
  };
}

export function openUnallocatedAlert(
  funds: {
    id: string;
    reason: string;
    providerReference: string;
    amount: number;
    createdAt: Date;
  },
  now: Date,
): ReconciliationAlert {
  return {
    kind: ReconciliationAlertKind.UNALLOCATED_OPEN,
    targetType: 'UnallocatedFunds',
    targetId: funds.id,
    since: funds.createdAt,
    amount: funds.amount,
    detail: `${mzn(funds.amount)} por atribuir (${funds.reason}, referência ${funds.providerReference}) há ${hoursSince(funds.createdAt, now)} h sem devolução.`,
  };
}
