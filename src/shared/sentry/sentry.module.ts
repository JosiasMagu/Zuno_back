import {
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { flushSentry, isSentryActive } from './sentry';

/**
 * Garante que a fila de eventos do Sentry é descarregada antes do processo
 * encerrar. Integra-se com `app.enableShutdownHooks()` do Nest, evitando o
 * tradicional race condition entre handlers manuais de SIGINT/SIGTERM e o
 * lifecycle interno do framework.
 */
@Injectable()
export class SentryShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger('Sentry');

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!isSentryActive()) return;
    this.logger.log(
      `A descarregar Sentry antes do shutdown (signal: ${signal ?? 'unknown'})...`,
    );
    try {
      await flushSentry();
    } catch (err) {
      this.logger.error({ err }, 'Falha ao descarregar Sentry no shutdown');
    }
  }
}

@Module({
  providers: [SentryShutdownService],
  exports: [SentryShutdownService],
})
export class SentryModule {}
