import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

/**
 * Regista o `IdempotencyInterceptor` globalmente. O interceptor é
 * inerte (passa direto) em endpoints que não tenham o decorator
 * `@Idempotent()` — zero custo onde não é necessário.
 */
@Global()
@Module({
  providers: [
    IdempotencyService,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
