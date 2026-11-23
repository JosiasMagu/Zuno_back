import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { Job } from '../../../shared/scheduling/job.decorator';
import { ReconciliationService } from '../services/reconciliation.service';

/**
 * Confere de hora a hora se o dinheiro bate certo. Só lê, por isso pode
 * correr em várias instâncias ao mesmo tempo sem estragar nada.
 */
@Injectable()
export class ReconciliationScheduler {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Job(CronExpression.EVERY_HOUR, 'money-reconciliation')
  async reconcile() {
    await this.reconciliation.runAndAlert();
  }
}
