import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { describeError } from '../../../shared/scheduling/process-due';
import { DisputesService } from '../services/disputes.service';
import { Job } from '../../../shared/scheduling/job.decorator';

/**
 * Relógio das disputas: de hora a hora, as que ficaram sem resposta dentro
 * do prazo seguem para análise, para o dinheiro não ficar parado à espera de
 * quem não aparece. Desactivado em NODE_ENV=test, como os outros schedulers.
 */
@Injectable()
export class DisputesScheduler {
  private readonly logger = new Logger(DisputesScheduler.name);

  constructor(private readonly disputes: DisputesService) {}

  @Job(CronExpression.EVERY_HOUR, 'disputes-response-window')
  async closeResponseWindows() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    try {
      const closed = await this.disputes.closeResponseWindows();
      if (closed > 0) {
        this.logger.log(
          `Disputas: ${closed} seguiram para análise sem resposta dentro do prazo.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Fecho dos prazos de resposta falhou: ${describeError(error)}`,
      );
    }
  }
}
