import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { Job } from '../../shared/scheduling/job.decorator';
import { IdempotencyService } from './idempotency.service';

/**
 * Limpa de hora a hora os registos de idempotência fora de prazo, para a
 * tabela não crescer sem fim.
 */
@Injectable()
export class IdempotencyScheduler {
  private readonly logger = new Logger(IdempotencyScheduler.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  @Job(CronExpression.EVERY_HOUR, 'idempotency-purge')
  async purgeExpired() {
    const purged = await this.idempotency.purgeExpired();
    if (purged > 0) {
      this.logger.log(
        `Idempotência: ${purged} registo(s) fora de prazo apagado(s).`,
      );
    }
  }
}
