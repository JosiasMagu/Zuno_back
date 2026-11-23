import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { PaymentsService } from '../../payments/services/payments.service';
import { BookingsService } from '../services/bookings.service';
import { Job } from '../../../shared/scheduling/job.decorator';

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
 * Desactivado em NODE_ENV=test, como o ServicesScheduler.
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
    if (process.env.NODE_ENV === 'test') return;

    try {
      const expired = await this.bookingsService.expireUnpaidBookings();
      if (expired > 0) {
        this.logger.log(`Expiração: ${expired} reserva(s) por pagar.`);
      }
    } catch (error) {
      this.logger.error(
        `Expiração de reservas falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Job(CronExpression.EVERY_HOUR, 'bookings-lifecycle-deadlines')
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
