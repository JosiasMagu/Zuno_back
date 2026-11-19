import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { describeError } from '../../../shared/scheduling/process-due';
import { PaymentsService } from '../services/payments.service';
import { PayoutDispatcher } from '../services/payout-dispatcher.service';
import { ProviderEventsService } from '../services/provider-events.service';
import { ProviderOperationsService } from '../services/provider-operations.service';

/**
 * Jobs do fornecedor de pagamentos: de minuto a minuto, pergunta pelas
 * operações sem resposta, trata os avisos que ficaram por tratar e envia os
 * payouts que podem sair sozinhos. De hora a hora, avisa os clientes cujo
 * pagamento vai ser libertado automaticamente.
 *
 * No modo manual os três primeiros não fazem nada. Desactivado em
 * NODE_ENV=test, como os outros schedulers. Antes de haver mais de uma
 * instância, precisa de um lock (ver o backlog no CLAUDE.md).
 */
@Injectable()
export class PaymentOperationsScheduler {
  private readonly logger = new Logger(PaymentOperationsScheduler.name);

  constructor(
    private readonly operations: ProviderOperationsService,
    private readonly events: ProviderEventsService,
    private readonly dispatcher: PayoutDispatcher,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'payment-provider-operations' })
  async everyMinute() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    await this.run('consulta das operações', () => this.operations.pollDue());
    await this.run('tratamento dos avisos', () => this.events.processPending());
    await this.run('envio dos payouts', () => this.dispatcher.dispatchDue());
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'payment-auto-release-reminders' })
  async everyHour() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    await this.run('lembretes da libertação automática', () =>
      this.payments.remindAutoReleaseDue(),
    );
  }

  private async run(label: string, job: () => Promise<number>) {
    try {
      const handled = await job();
      if (handled > 0) {
        this.logger.log(`Pagamentos, ${label}: ${handled}.`);
      }
    } catch (error) {
      this.logger.error(`Pagamentos, ${label} falhou: ${describeError(error)}`);
    }
  }
}
