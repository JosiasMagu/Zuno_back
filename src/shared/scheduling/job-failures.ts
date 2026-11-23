import { HttpException, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';

import { captureUnhandled } from '../sentry/sentry';
import { describeError } from './process-due';

/**
 * Falhas dos jobs agendados. `scope` é `run` quando falhou a execução ou um
 * passo inteiro, e `item` quando falhou um item, que fica para a execução
 * seguinte. Fica fora do registo: quem o expõe é o `MetricsService`.
 */
export const jobFailuresTotal = new Counter({
  name: 'zuno_job_failures_total',
  help: 'Scheduled job failures, by job and scope (run: the run or a whole step failed; item: one item failed and waits for the next run).',
  labelNames: ['job', 'scope'] as const,
  registers: [],
});

const logger = new Logger('Jobs');

/**
 * Um conflito com outro pedido ou uma regra que já não se cumpre são
 * respostas normais a um job que chegou tarde. Não vão para o Sentry.
 */
const isExpected = (error: unknown) =>
  error instanceof HttpException && error.getStatus() < 500;

export function reportJobFailure(
  job: string,
  scope: 'run' | 'item',
  error: unknown,
  itemId?: string,
): void {
  const text = `${itemId ? `${job}, item ${itemId}` : job}: ${describeError(error)}`;
  jobFailuresTotal.inc({ job, scope });

  if (isExpected(error)) {
    logger.warn(text);
    return;
  }

  logger.error(text, error instanceof Error ? error.stack : undefined);
  captureUnhandled(error);
}

/** Para o `onFailure` de `processDue`. */
export const itemFailureOf =
  (job: string) =>
  (item: { id: string }, error: unknown): void =>
    reportJobFailure(job, 'item', error, item.id);

/**
 * Corre um passo de um job que tem vários. Se falhar, a falha fica reportada
 * e os passos seguintes correm na mesma.
 */
export async function runJobStep<T>(
  job: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    reportJobFailure(job, 'run', error);
    return undefined;
  }
}
