import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { IdempotencyService } from './idempotency.service';

/**
 * Limpa de hora a hora os registos de idempotência fora de prazo, para a
 * tabela não crescer sem fim. Desactivado em NODE_ENV=test.
 */
@Injectable()
export class IdempotencyScheduler {
  private readonly logger = new Logger(IdempotencyScheduler.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'idempotency-purge' })
  async purgeExpired() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    try {
      const purged = await this.idempotency.purgeExpired();
      if (purged > 0) {
        this.logger.log(
          `Idempotência: ${purged} registo(s) fora de prazo apagado(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Limpeza da idempotência falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
