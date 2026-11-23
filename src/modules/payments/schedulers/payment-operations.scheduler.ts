import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { runJobStep } from '../../../shared/scheduling/job-failures';
import { Job } from '../../../shared/scheduling/job.decorator';
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
 * No modo manual os três primeiros não fazem nada. Antes de haver mais de
 * uma instância, precisa de um lock (ver o backlog no CLAUDE.md).
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

  @Job(CronExpression.EVERY_MINUTE, 'payment-provider-operations')
  async everyMinute() {
    await this.step('provider-operations-poll', 'consulta das operações', () =>
      this.operations.pollDue(),
    );
    await this.step('provider-events', 'tratamento dos avisos', () =>
      this.events.processPending(),
    );
    await this.step('payout-dispatch', 'envio dos payouts', () =>
      this.dispatcher.dispatchDue(),
    );
  }

  @Job(CronExpression.EVERY_HOUR, 'payment-auto-release-reminders')
  async everyHour() {
    const reminded = await this.payments.remindAutoReleaseDue();
    this.logHandled('lembretes da libertação automática', reminded);
  }

  /** Um passo que falha não trava os seguintes. */
  private async step(job: string, label: string, work: () => Promise<number>) {
    this.logHandled(label, await runJobStep(job, work));
  }

  private logHandled(label: string, handled = 0) {
    if (handled > 0) {
      this.logger.log(`Pagamentos, ${label}: ${handled}.`);
    }
  }
}
