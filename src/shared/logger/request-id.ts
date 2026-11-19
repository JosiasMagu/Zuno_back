import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Formato aceite num id vindo de fora: curto, sem espaços nem quebras de linha. */
const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Dá a cada pedido um id que o acompanha nos logs, no cabeçalho da resposta
 * e no corpo dos erros, para se seguir um pedido de ponta a ponta.
 *
 * Se quem chama (a app, um proxy) já enviou um `X-Request-Id` com formato
 * aceitável, usa-se esse. Um valor estranho é ignorado, para ninguém
 * escrever o que quiser nos logs.
 */
export function assignRequestId(
  request: IncomingMessage,
  response: ServerResponse,
): string {
  const incoming = request.headers[REQUEST_ID_HEADER.toLowerCase()];
  const id =
    typeof incoming === 'string' && ACCEPTABLE_ID.test(incoming)
      ? incoming
      : randomUUID();

  response.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
