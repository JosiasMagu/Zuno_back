import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { jobFailuresTotal } from '../scheduling/job-failures';

/**
 * Registry isolado da Zuno + métricas custom.
 *
 * Em vez de usar o registry global do prom-client (que pode acumular
 * de várias instâncias em testes), mantemos o nosso próprio para
 * controlo total. `collectDefaultMetrics({ register })` cobre as
 * métricas standard do Node: heap, GC, event-loop lag, CPU, etc.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'zuno_http_requests_total',
    help: 'Total HTTP requests received, broken down by method, route and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDurationSeconds = new Histogram({
    name: 'zuno_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method/route/status.',
    labelNames: ['method', 'route', 'status'] as const,
    // Buckets razoáveis para API REST: 5ms até 10s
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** Counter de eventos de negócio. Use labels p/ distinguir tipos. */
  readonly businessEvents = new Counter({
    name: 'zuno_business_events_total',
    help: 'Counter for domain events (bookings, payments, reviews, disputes...).',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  /**
   * Divergências que a última reconciliação do dinheiro encontrou. Qualquer
   * valor acima de zero pede um humano.
   */
  readonly reconciliationFindings = new Gauge({
    name: 'zuno_reconciliation_findings',
    help: 'Mismatches found by the last money reconciliation run. Anything above zero needs a human.',
    registers: [this.registry],
  });

  /** Dinheiro no escrow segundo o ledger: entradas menos saídas. */
  readonly escrowHeld = new Gauge({
    name: 'zuno_escrow_held_mzn',
    help: 'Money held in escrow according to the ledger (inflows minus outflows), in MZN.',
    registers: [this.registry],
  });

  /** Payouts já decididos e ainda por executar. */
  readonly payoutsOwed = new Gauge({
    name: 'zuno_payouts_owed_mzn',
    help: 'Payouts decided but not executed yet, in MZN.',
    registers: [this.registry],
  });

  /**
   * O que a última reconciliação encontrou parado tempo demais, por tipo:
   * OPERATION_STUCK, PAYOUT_STALE, UNALLOCATED_OPEN.
   */
  readonly reconciliationAlerts = new Gauge({
    name: 'zuno_reconciliation_alerts',
    help: 'Items waiting too long found by the last money reconciliation run, by kind.',
    labelNames: ['kind'],
    registers: [this.registry],
  });

  /** Dinheiro na conta que não fecha nenhum pagamento e ainda não foi devolvido. */
  readonly unallocatedFunds = new Gauge({
    name: 'zuno_unallocated_funds_mzn',
    help: 'Money received that closes no payment and has not been returned yet, in MZN.',
    registers: [this.registry],
  });

  onModuleInit(): void {
    this.registry.registerMetric(jobFailuresTotal);
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'zuno_node_',
    });
  }

  async exportMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
