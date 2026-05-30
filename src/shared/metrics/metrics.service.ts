import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

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

  onModuleInit(): void {
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
