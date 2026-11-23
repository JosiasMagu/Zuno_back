import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { Job } from '../../../shared/scheduling/job.decorator';
import { DisputesService } from '../services/disputes.service';

/**
 * Relógio das disputas: de hora a hora, as que ficaram sem resposta dentro
 * do prazo seguem para análise, para o dinheiro não ficar parado à espera de
 * quem não aparece.
 */
@Injectable()
export class DisputesScheduler {
  private readonly logger = new Logger(DisputesScheduler.name);

  constructor(private readonly disputes: DisputesService) {}

  @Job(CronExpression.EVERY_HOUR, 'disputes-response-window')
  async closeResponseWindows() {
    const closed = await this.disputes.closeResponseWindows();
    if (closed > 0) {
      this.logger.log(
        `Disputas: ${closed} seguiram para análise sem resposta dentro do prazo.`,
      );
    }
  }
}
