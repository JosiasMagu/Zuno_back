import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { runJobStep } from '../../../shared/scheduling/job-failures';
import { Job } from '../../../shared/scheduling/job.decorator';
import { PaymentsService } from '../../payments/services/payments.service';
import { BookingsService } from '../services/bookings.service';

/**
 * Relógio do ciclo de vida do aluguer (decisão D1 em docs/DECISOES-FASE-0.md):
 * - auto-release: se a entrega não for confirmada nem disputada dentro do
 *   prazo, liberta o pagamento ao provider.
 * - auto-devolução: quando a janela de reclamação do depósito expira,
 *   conclui a reserva e devolve o depósito ao cliente.
 * - expiração: a reserva que não foi paga dentro do prazo expira e deixa de
 *   ocupar as datas (decisão D5).
 *
 * Idempotente (as queries filtram por estado); seguro re-executar.
 */
@Injectable()
export class BookingsScheduler {
  private readonly logger = new Logger(BookingsScheduler.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly bookingsService: BookingsService,
  ) {}

  @Job(CronExpression.EVERY_10_MINUTES, 'bookings-expire-unpaid')
  async expireUnpaidBookings() {
    const expired = await this.bookingsService.expireUnpaidBookings();
    if (expired > 0) {
      this.logger.log(`Expiração: ${expired} reserva(s) por pagar.`);
    }
  }

  @Job(CronExpression.EVERY_HOUR, 'bookings-lifecycle-deadlines')
  async handleLifecycleDeadlines() {
    const released = await runJobStep('auto-release', () =>
      this.paymentsService.autoReleaseDue(),
    );
    if (released) {
      this.logger.log(`Auto-release: ${released} pagamento(s) liberado(s).`);
    }

    const returned = await runJobStep('deposit-auto-return', () =>
      this.bookingsService.autoReturnDepositsDue(),
    );
    if (returned) {
      this.logger.log(`Auto-devolução: ${returned} depósito(s) devolvido(s).`);
    }
  }
}
