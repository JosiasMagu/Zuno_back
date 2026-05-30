import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode } from './error-codes';

/**
 * Exception base da API com `errorCode` explícito.
 *
 * Lança quando queres que o frontend trate programaticamente um caso
 * específico (ex.: "esse equipamento foi removido" → mostrar tela diferente
 * de "esse equipamento não existe"). Para erros genéricos, continua a
 * usar `NotFoundException`, `BadRequestException`, etc.; o filter
 * adiciona um `errorCode` automaticamente a partir do HTTP status.
 *
 * @example
 *   throw new ApiException(
 *     ErrorCode.EQUIPMENT_NOT_AVAILABLE,
 *     'Este equipamento não está disponível.',
 *     HttpStatus.BAD_REQUEST,
 *   );
 */
export class ApiException extends HttpException {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ errorCode, message, details }, status);
  }
}

/**
 * Helpers prontos para os casos mais comuns. Reduzem boilerplate
 * e garantem consistência de mensagens.
 */
export const ApiErrors = {
  notFound: (errorCode: ErrorCode, message: string) =>
    new ApiException(errorCode, message, HttpStatus.NOT_FOUND),

  forbidden: (errorCode: ErrorCode, message: string) =>
    new ApiException(errorCode, message, HttpStatus.FORBIDDEN),

  badRequest: (errorCode: ErrorCode, message: string, details?: unknown) =>
    new ApiException(errorCode, message, HttpStatus.BAD_REQUEST, details),

  conflict: (errorCode: ErrorCode, message: string) =>
    new ApiException(errorCode, message, HttpStatus.CONFLICT),

  unauthorized: (errorCode: ErrorCode, message: string) =>
    new ApiException(errorCode, message, HttpStatus.UNAUTHORIZED),
} as const;
