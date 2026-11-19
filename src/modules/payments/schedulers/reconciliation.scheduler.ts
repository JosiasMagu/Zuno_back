import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { describeError } from '../../../shared/scheduling/process-due';
import { ReconciliationService } from '../services/reconciliation.service';

/**
 * Confere de hora a hora se o dinheiro bate certo. Só lê, por isso pode
 * correr em várias instâncias ao mesmo tempo sem estragar nada.
 * Desactivado em NODE_ENV=test, como os outros schedulers.
 */
@Injectable()
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(private readonly reconciliation: ReconciliationService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'money-reconciliation' })
  async reconcile() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    try {
      await this.reconciliation.runAndAlert();
    } catch (error) {
      this.logger.error(`Reconciliação falhou: ${describeError(error)}`);
    }
  }
}
