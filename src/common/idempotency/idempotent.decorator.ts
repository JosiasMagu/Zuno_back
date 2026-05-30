import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotency:enabled';

export interface IdempotentOptions {
  /** TTL do registo em horas. Default 24h. */
  ttlHours?: number;
}

/**
 * Marca um endpoint como idempotente — o `IdempotencyInterceptor` exige
 * o cabeçalho `Idempotency-Key` em cada chamada. Retries com a mesma key
 * devolvem a resposta original em vez de re-executar.
 *
 * @example
 *   @Post()
 *   @Idempotent()  // requer header Idempotency-Key
 *   create(@Body() dto) { ... }
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, { ttlHours: options.ttlHours ?? 24 });
