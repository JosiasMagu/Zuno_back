import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LedgerDirection,
  LedgerParty,
  PayoutKind,
  PayoutStatus,
  Prisma,
  ProviderOperationStatus,
  UnallocatedStatus,
} from '@prisma/client';

import { roundMoney } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { captureUnhandled } from '../../../shared/sentry/sentry';
import { payoutControls, payoutNeedsApproval } from '../money-controls';
import {
  PaymentSnapshot,
  reconcilePayment,
  ReconciliationFinding,
} from '../reconciliation';
import {
  alertCutoffs,
  failedPayoutAlert,
  openUnallocatedAlert,
  ReconciliationAlert,
  ReconciliationAlertKind,
  stalePayoutAlert,
  stuckOperationAlert,
} from '../reconciliation-alerts';

/** Quantos pagamentos se conferem de cada vez. */
const BATCH_SIZE = 500;

/** Quantas divergências a resposta leva, no máximo. O total vem sempre. */
const MAX_FINDINGS_RETURNED = 200;

/** Quantos alertas de cada tipo se lêem, no máximo. O total vem sempre. */
const MAX_ALERTS_PER_KIND = 100;

const ACTIVE_OPERATION: ProviderOperationStatus[] = [
  ProviderOperationStatus.REQUESTED,
  ProviderOperationStatus.PENDING,
  ProviderOperationStatus.UNKNOWN,
];

/** Dinheiro por atribuir que ainda está na conta. */
const UNALLOCATED_IN_ACCOUNT: UnallocatedStatus[] = [
  UnallocatedStatus.OPEN,
  UnallocatedStatus.RETURNING,
];

const PAYOUTS_TO_CLIENT: PayoutKind[] = [
  PayoutKind.CLIENT_REFUND,
  PayoutKind.DEPOSIT_RETURN,
];

const PAYMENT_SELECT = {
  id: true,
  receiptNumber: true,
  status: true,
  depositStatus: true,
  totalCharged: true,
  depositAmount: true,
  heldAt: true,
  booking: { select: { status: true } },
  serviceBooking: { select: { status: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** Para onde foi o dinheiro que entrou, somado por todos os pagamentos. */
export interface ReconciliationTotals {
  /** Tudo o que os clientes pagaram e entrou no escrow. */
  received: number;
  /** O que ainda não foi atribuído a ninguém: entradas menos saídas. */
  heldInEscrow: number;
  /** Saídas já decididas cujo payout ainda não foi executado. */
  owedInPayouts: number;
  /** Payouts já executados por M-Pesa. */
  paidOut: number;
  /** A parte da plataforma. Não sai por payout: fica na conta. */
  platformShare: number;
  /**
   * Dinheiro que entrou sem fechar nenhum pagamento e ainda não voltou a
   * quem pagou (por atribuir ou a ser devolvido). Está na conta, mas não é
   * da plataforma.
   */
  unallocatedInAccount: number;
  /** O que o fornecedor cobrou nas operações confirmadas, quando o diz. */
  providerFees: number;
  /**
   * O que devia estar na conta M-Pesa: o que entrou nos pagamentos, mais o
   * dinheiro por atribuir, menos os payouts executados e as taxas.
   */
  expectedInAccount: number;
}

interface AccountExtras {
  unallocatedInAccount: number;
  providerFees: number;
}

export interface ReconciliationReport {
  checkedAt: Date;
  paymentsChecked: number;
  totals: ReconciliationTotals;
  findingsTotal: number;
  findings: ReconciliationFinding[];
  /** O que está parado tempo demais. Não conta como divergência. */
  alertsTotal: number;
  alerts: ReconciliationAlert[];
}

interface Sums {
  received: number;
  outflow: number;
  platformShare: number;
  owedInPayouts: number;
  paidOut: number;
}

/**
 * Confere se o dinheiro bate certo.
 *
 * Para cada pagamento compara o ledger, o estado, os payouts e a reserva.
 * É só de leitura: aponta o que encontra e nunca corrige. Uma divergência
 * quer dizer que há um defeito no código ou que alguém mexeu na base à mão,
 * e as duas coisas pedem um humano.
 *
 * À parte das divergências, aponta o que espera tempo demais: operações no
 * fornecedor sem resposta, payouts por executar e dinheiro por atribuir que
 * ninguém devolveu.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  async run(): Promise<ReconciliationReport> {
    const findings: ReconciliationFinding[] = [];
    const sums: Sums = {
      received: 0,
      outflow: 0,
      platformShare: 0,
      owedInPayouts: 0,
      paidOut: 0,
    };
    let paymentsChecked = 0;
    let cursor: string | undefined;

    for (;;) {
      const snapshots = await this.readBatch(cursor, sums);
      if (snapshots.length === 0) break;

      for (const snapshot of snapshots) {
        findings.push(...reconcilePayment(snapshot));
      }

      paymentsChecked += snapshots.length;
      cursor = snapshots[snapshots.length - 1].id;
      if (snapshots.length < BATCH_SIZE) break;
    }

    const checkedAt = new Date();
    const [extras, alerts] = await Promise.all([
      this.readAccountExtras(),
      this.readAlerts(checkedAt),
    ]);

    const report: ReconciliationReport = {
      checkedAt,
      paymentsChecked,
      totals: this.toTotals(sums, extras),
      findingsTotal: findings.length,
      findings: findings.slice(0, MAX_FINDINGS_RETURNED),
      alertsTotal: alerts.total,
      alerts: alerts.items,
    };

    this.publish(report);
    return report;
  }

  /**
   * Corre a reconciliação a pedido do scheduler. Com divergências, grita no
   * log e no Sentry: é o alarme de que o dinheiro deixou de bater certo.
   */
  async runAndAlert(): Promise<ReconciliationReport> {
    const report = await this.run();

    if (report.alertsTotal > 0) {
      const sample = report.alerts
        .slice(0, 10)
        .map(({ kind, targetId }) => `${kind}:${targetId}`)
        .join(', ');
      this.logger.warn(
        `${report.alertsTotal} alerta(s) de dinheiro parado: ${sample}`,
      );
    }

    if (report.findingsTotal === 0) {
      this.logger.log(
        `Reconciliação sem divergências em ${report.paymentsChecked} pagamento(s).`,
      );
      return report;
    }

    const sample = report.findings
      .slice(0, 10)
      .map(({ receiptNumber, check }) => `${receiptNumber}:${check}`)
      .join(', ');
    const message = `Reconciliação com ${report.findingsTotal} divergência(s) em ${report.paymentsChecked} pagamento(s): ${sample}`;

    this.logger.error(message);
    captureUnhandled(new Error(message));
    return report;
  }

  /**
   * Lê um lote de pagamentos com as somas do ledger e dos payouts, tudo na
   * mesma fotografia da base, para um pagamento a meio de uma operação não
   * aparecer como divergência.
   */
  private readBatch(
    cursor: string | undefined,
    sums: Sums,
  ): Promise<PaymentSnapshot[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const payments = await tx.payment.findMany({
          take: BATCH_SIZE,
          orderBy: { id: 'asc' },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: PAYMENT_SELECT,
        });
        if (payments.length === 0) return [];

        const paymentIds = payments.map(({ id }) => id);
        const [ledger, payouts] = await Promise.all([
          tx.ledgerEntry.groupBy({
            by: ['paymentId', 'direction', 'party'],
            where: { paymentId: { in: paymentIds } },
            _sum: { amount: true },
          }),
          tx.payout.groupBy({
            by: ['paymentId', 'kind', 'status'],
            where: { paymentId: { in: paymentIds } },
            _sum: { amount: true },
          }),
        ]);

        const snapshots = new Map(
          payments.map((payment) => [payment.id, this.emptySnapshot(payment)]),
        );

        for (const row of ledger) {
          this.addLedgerRow(
            snapshots.get(row.paymentId),
            row,
            Number(row._sum.amount ?? 0),
            sums,
          );
        }

        for (const row of payouts) {
          this.addPayoutRow(
            snapshots.get(row.paymentId),
            row,
            Number(row._sum.amount ?? 0),
            sums,
          );
        }

        return [...snapshots.values()];
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private emptySnapshot(payment: PaymentRow): PaymentSnapshot {
    return {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      status: payment.status,
      depositStatus: payment.depositStatus,
      totalCharged: Number(payment.totalCharged),
      depositAmount: Number(payment.depositAmount),
      everHeld: payment.heldAt !== null,
      bookingStatus: payment.booking?.status ?? null,
      serviceBookingStatus: payment.serviceBooking?.status ?? null,
      ledger: {
        inflow: 0,
        outflowToClient: 0,
        outflowToProvider: 0,
        outflowToPlatform: 0,
      },
      payouts: { toClient: 0, toProvider: 0 },
    };
  }

  private addLedgerRow(
    snapshot: PaymentSnapshot | undefined,
    row: { direction: LedgerDirection; party: LedgerParty },
    amount: number,
    sums: Sums,
  ) {
    if (!snapshot) return;

    if (row.direction === LedgerDirection.INFLOW) {
      snapshot.ledger.inflow += amount;
      sums.received += amount;
      return;
    }

    // Um estorno anula uma entrada que não chegou a existir.
    if (row.party === LedgerParty.REVERSAL) {
      snapshot.ledger.inflow -= amount;
      sums.received -= amount;
      return;
    }

    sums.outflow += amount;

    if (row.party === LedgerParty.CLIENT) {
      snapshot.ledger.outflowToClient += amount;
    } else if (row.party === LedgerParty.PROVIDER) {
      snapshot.ledger.outflowToProvider += amount;
    } else {
      snapshot.ledger.outflowToPlatform += amount;
      sums.platformShare += amount;
    }
  }

  private addPayoutRow(
    snapshot: PaymentSnapshot | undefined,
    row: { kind: PayoutKind; status: PayoutStatus },
    amount: number,
    sums: Sums,
  ) {
    if (!snapshot) return;

    if (PAYOUTS_TO_CLIENT.includes(row.kind)) {
      snapshot.payouts.toClient += amount;
    } else {
      snapshot.payouts.toProvider += amount;
    }

    if (row.status === PayoutStatus.EXECUTED) {
      sums.paidOut += amount;
    } else {
      sums.owedInPayouts += amount;
    }
  }

  /** O dinheiro na conta que não passa pelo ledger dos pagamentos. */
  private async readAccountExtras(): Promise<AccountExtras> {
    const [unallocated, fees] = await Promise.all([
      this.prisma.unallocatedFunds.aggregate({
        where: { status: { in: UNALLOCATED_IN_ACCOUNT } },
        _sum: { amount: true },
      }),
      this.prisma.providerOperation.aggregate({
        where: {
          status: ProviderOperationStatus.CONFIRMED,
          feeAmount: { not: null },
        },
        _sum: { feeAmount: true },
      }),
    ]);

    return {
      unallocatedInAccount: Number(unallocated._sum.amount ?? 0),
      providerFees: Number(fees._sum.feeAmount ?? 0),
    };
  }

  /** Lê o que está parado há tempo demais, por tipo. */
  private async readAlerts(
    now: Date,
  ): Promise<{ total: number; items: ReconciliationAlert[] }> {
    const cutoff = alertCutoffs(now);
    const controls = payoutControls(this.config);

    const operationsWhere: Prisma.ProviderOperationWhereInput = {
      status: { in: ACTIVE_OPERATION },
      createdAt: { lte: cutoff.operations },
    };
    const payoutsWhere: Prisma.PayoutWhereInput = {
      status: PayoutStatus.PENDING,
      createdAt: { lte: cutoff.payouts },
    };
    const failedWhere: Prisma.PayoutWhereInput = {
      status: PayoutStatus.FAILED,
    };
    const unallocatedWhere: Prisma.UnallocatedFundsWhereInput = {
      status: UnallocatedStatus.OPEN,
      createdAt: { lte: cutoff.unallocated },
    };

    const [operations, payouts, failed, unallocated, counts] =
      await Promise.all([
        this.prisma.providerOperation.findMany({
          where: operationsWhere,
          orderBy: { createdAt: 'asc' },
          take: MAX_ALERTS_PER_KIND,
        }),
        this.prisma.payout.findMany({
          where: payoutsWhere,
          orderBy: { createdAt: 'asc' },
          take: MAX_ALERTS_PER_KIND,
          include: { payment: { select: { heldById: true } } },
        }),
        this.prisma.payout.findMany({
          where: failedWhere,
          orderBy: { updatedAt: 'asc' },
          take: MAX_ALERTS_PER_KIND,
        }),
        this.prisma.unallocatedFunds.findMany({
          where: unallocatedWhere,
          orderBy: { createdAt: 'asc' },
          take: MAX_ALERTS_PER_KIND,
        }),
        Promise.all([
          this.prisma.providerOperation.count({ where: operationsWhere }),
          this.prisma.payout.count({ where: payoutsWhere }),
          this.prisma.payout.count({ where: failedWhere }),
          this.prisma.unallocatedFunds.count({ where: unallocatedWhere }),
        ]),
      ]);

    const items = [
      ...operations.map((operation) =>
        stuckOperationAlert(
          { ...operation, amount: Number(operation.amount) },
          now,
        ),
      ),
      ...payouts.map((payout) =>
        stalePayoutAlert(
          {
            ...payout,
            amount: Number(payout.amount),
            needsApproval: payoutNeedsApproval(payout, controls),
          },
          now,
        ),
      ),
      ...failed.map((payout) =>
        failedPayoutAlert({ ...payout, amount: Number(payout.amount) }, now),
      ),
      ...unallocated.map((funds) =>
        openUnallocatedAlert({ ...funds, amount: Number(funds.amount) }, now),
      ),
    ];

    const [stuck, stale, failedTotal, open] = counts;
    this.metrics.reconciliationAlerts.set(
      { kind: ReconciliationAlertKind.OPERATION_STUCK },
      stuck,
    );
    this.metrics.reconciliationAlerts.set(
      { kind: ReconciliationAlertKind.PAYOUT_STALE },
      stale,
    );
    this.metrics.reconciliationAlerts.set(
      { kind: ReconciliationAlertKind.PAYOUT_FAILED },
      failedTotal,
    );
    this.metrics.reconciliationAlerts.set(
      { kind: ReconciliationAlertKind.UNALLOCATED_OPEN },
      open,
    );

    return { total: stuck + stale + failedTotal + open, items };
  }

  private toTotals(sums: Sums, extras: AccountExtras): ReconciliationTotals {
    return {
      received: roundMoney(sums.received),
      heldInEscrow: roundMoney(sums.received - sums.outflow),
      owedInPayouts: roundMoney(sums.owedInPayouts),
      paidOut: roundMoney(sums.paidOut),
      platformShare: roundMoney(sums.platformShare),
      unallocatedInAccount: roundMoney(extras.unallocatedInAccount),
      providerFees: roundMoney(extras.providerFees),
      expectedInAccount: roundMoney(
        sums.received +
          extras.unallocatedInAccount -
          sums.paidOut -
          extras.providerFees,
      ),
    };
  }

  private publish(report: ReconciliationReport) {
    this.metrics.reconciliationFindings.set(report.findingsTotal);
    this.metrics.escrowHeld.set(report.totals.heldInEscrow);
    this.metrics.payoutsOwed.set(report.totals.owedInPayouts);
    this.metrics.unallocatedFunds.set(report.totals.unallocatedInAccount);
  }
}
