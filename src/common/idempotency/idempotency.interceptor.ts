import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import { ApiErrors, ApiException } from '../exceptions/api.exception';
import { ErrorCode } from '../exceptions/error-codes';
import {
  IDEMPOTENT_KEY,
  type IdempotentOptions,
} from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';

/**
 * Interceptor global que torna endpoints marcados com `@Idempotent()`
 * resilientes a retries. Fluxo:
 *
 *  1. Lê `Idempotency-Key` do header — obrigatório se decorator presente.
 *  2. Hash do body para detectar reuso da mesma key com payload diferente.
 *  3. Tenta adquirir lock optimista na tabela IdempotencyKey:
 *     - acquired → processa handler e cacheia a resposta no fim
 *     - replay   → devolve a resposta cacheada (200 vira 200, etc.)
 *     - in-progress → 409 (cliente deve fazer backoff e retry)
 *     - mismatch → 409 com IDEMPOTENCY_KEY_MISMATCH
 *  4. Se o handler der erro, liberta o lock para permitir retry imediato.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      ctx.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const request = ctx.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const response = ctx.switchToHttp().getResponse<Response>();

    const key = (request.headers['idempotency-key'] as string | undefined)?.trim();
    if (!key) {
      throw ApiErrors.badRequest(
        ErrorCode.BAD_REQUEST,
        'Cabeçalho Idempotency-Key é obrigatório para este endpoint.',
      );
    }

    const userId = request.user?.id;
    if (!userId) {
      throw ApiErrors.unauthorized(
        ErrorCode.UNAUTHORIZED,
        'Autenticação necessária para usar Idempotency-Key.',
      );
    }

    const endpoint = `${request.method} ${(request as any).route?.path ?? request.url}`;
    const requestHash = this.idempotency.hashRequestBody(request.body);

    const result = await this.idempotency.tryAcquire({
      key,
      userId,
      endpoint,
      requestHash,
      ttlHours: options.ttlHours ?? 24,
    });

    if (result.status === 'mismatch') {
      throw new ApiException(
        ErrorCode.IDEMPOTENCY_KEY_MISMATCH,
        'Esta Idempotency-Key já foi usada com um corpo diferente.',
        HttpStatus.CONFLICT,
      );
    }

    if (result.status === 'in-progress') {
      throw new ApiException(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Pedido com esta Idempotency-Key ainda está a ser processado. Tente novamente em instantes.',
        HttpStatus.CONFLICT,
      );
    }

    if (result.status === 'replay') {
      response.status(result.response.statusCode);
      return of(result.response.body);
    }

    // 'acquired' — processar handler e cachear resposta
    return next.handle().pipe(
      tap((body: unknown) => {
        const statusCode = response.statusCode || HttpStatus.OK;
        // fire-and-forget: não bloqueia a resposta ao cliente
        void this.idempotency.complete({
          key,
          userId,
          endpoint,
          statusCode,
          body,
        });
      }),
      catchError((err: unknown) => {
        // Liberta o lock para o cliente poder retentar de imediato
        void this.idempotency.release({ key, userId, endpoint });
        return throwError(() => err);
      }),
    );
  }
}
