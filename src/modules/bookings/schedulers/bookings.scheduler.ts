import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PaymentsService } from '../../payments/services/payments.service';
import { BookingsService } from '../services/bookings.service';

/**
 * Relógio do ciclo de vida do aluguer (D1):
 * - auto-release: entrega não confirmada nem disputada dentro do prazo
 *   → liberta o pagamento ao provider.
 * - auto-devolução: janela de reclamação do depósito expirada
 *   → conclui a reserva e devolve o depósito ao cliente.
 *
 * Idempotente (as queries filtram por estado); seguro re-executar.
 * Desactivado em NODE_ENV=test, como o ServicesScheduler.
 */
@Injectable()
export class BookingsScheduler {
  private readonly logger = new Logger(BookingsScheduler.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly bookingsService: BookingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleLifecycleDeadlines() {
    if (process.env.NODE_ENV === 'test') return;

    try {
      const released = await this.paymentsService.autoReleaseDue();
      if (released > 0) {
        this.logger.log(`Auto-release: ${released} pagamento(s) liberado(s).`);
      }
    } catch (error) {
      this.logger.error(
        `Auto-release falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const returned = await this.bookingsService.autoReturnDepositsDue();
      if (returned > 0) {
        this.logger.log(
          `Auto-devolução: ${returned} depósito(s) devolvido(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Auto-devolução falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
