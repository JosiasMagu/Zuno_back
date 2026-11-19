import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';

import { ApiErrors, ApiException } from '../exceptions/api.exception';
import { ErrorCode } from '../exceptions/error-codes';
import { IDEMPOTENT_KEY, type IdempotentOptions } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';

/**
 * Torna as rotas marcadas com `@Idempotent()` seguras de repetir.
 *
 *  1. Exige o cabeçalho `Idempotency-Key`.
 *  2. Identifica o pedido pela chave, por quem o envia e pelo caminho real,
 *     com os ids. A mesma chave em dois recursos são dois pedidos.
 *  3. Com a chave livre, o pedido corre e a resposta fica guardada antes de
 *     seguir para o cliente.
 *  4. Com a chave já usada: repete a resposta guardada, ou responde 409 se o
 *     primeiro pedido ainda corre ou se os dados mudaram.
 *  5. Se o pedido falhar, a chave fica livre para uma nova tentativa.
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

    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: { id: string } }>();
    const response = ctx.switchToHttp().getResponse<Response>();

    const key = (
      request.headers['idempotency-key'] as string | undefined
    )?.trim();
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

    // O caminho real, e não o padrão da rota: `PATCH /payments/A/release` e
    // `PATCH /payments/B/release` são pedidos diferentes.
    const path = (request.originalUrl ?? request.url).split('?')[0];
    const idempotent = { key, userId, endpoint: `${request.method} ${path}` };

    const result = await this.idempotency.tryAcquire({
      ...idempotent,
      requestHash: this.idempotency.hashRequest(request.body, request.query),
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

    return next.handle().pipe(
      // A resposta só segue depois de guardada. Se seguisse antes, uma falha
      // ao guardar deixava a chave "em curso" sem ninguém dar por isso.
      concatMap(async (body: unknown) => {
        await this.idempotency.complete({
          ...idempotent,
          statusCode: response.statusCode || HttpStatus.OK,
          body,
        });
        return body;
      }),
      catchError((error: unknown) =>
        from(this.idempotency.release(idempotent)).pipe(
          concatMap(() => throwError(() => error)),
        ),
      ),
    );
  }
}
