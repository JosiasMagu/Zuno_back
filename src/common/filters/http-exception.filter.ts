import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { ErrorCode, inferErrorCode } from '../exceptions/error-codes';
import { captureUnhandled } from '../../shared/sentry/sentry';

/**
 * Filter global de excepções. Garante que TODA resposta de erro tem o
 * mesmo shape, com um `errorCode` estável para tratamento programático.
 *
 *   {
 *     "errorCode": "EQUIPMENT_NOT_FOUND",   // <-- novo: usado pelo frontend
 *     "statusCode": 404,
 *     "message": "Equipamento não encontrado.",
 *     "details": ...   // opcional, contexto adicional
 *     "path": "/api/v1/equipment/abc",
 *     "timestamp": "2026-05-30T19:34:12.420Z",
 *     "stack": "..."   // só em dev
 *   }
 *
 * O `errorCode` vem de:
 *   1. `ApiException` (campo `errorCode` no payload) — explícito; ou
 *   2. fallback inferido a partir do HTTP status.
 *
 * Erros 5xx são reportados ao Sentry (se configurado).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Erro interno do servidor.';
    let errorCode: string = ErrorCode.INTERNAL_ERROR;
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      errorCode = inferErrorCode(status);
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;

        // `ApiException` traz `errorCode` no payload — tem prioridade
        if (typeof resp.errorCode === 'string') {
          errorCode = resp.errorCode;
        }

        if (Array.isArray(resp.message)) {
          message = (resp.message as string[]).join('; ');
        } else if (typeof resp.message === 'string') {
          message = resp.message;
        }

        // Suporta tanto `details` (ApiException) como `error` (legado)
        details = resp.details ?? resp.error ?? undefined;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}`,
        exception.stack,
      );
    }

    if (Number(status) >= 500) {
      captureUnhandled(exception);
    }

    const isDev = process.env.NODE_ENV !== 'production';

    response.status(status).json({
      errorCode,
      statusCode: status,
      message,
      ...(details !== undefined ? { details } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(isDev && exception instanceof Error
        ? { stack: exception.stack }
        : {}),
    });
  }
}
