import type { PoolConfig } from 'pg';

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
/** Uma transacção esquecida aberta não fica com a ligação e com os locks. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

type Settings = { get<T>(key: string): T | undefined };

/**
 * O pool de ligações à base, com limites.
 *
 * Sem eles um pedido espera para sempre por uma ligação livre e uma consulta
 * lenta fica com a sua o tempo que quiser: meia dúzia de pesquisas pesadas
 * paravam os pagamentos e o /ready.
 */
export function poolConfig(
  connectionString: string,
  settings: Settings,
): PoolConfig {
  const numberOf = (key: string, fallback: number) =>
    Number(settings.get(key) ?? fallback);

  return {
    connectionString,
    max: numberOf('DATABASE_POOL_MAX', DEFAULT_MAX_CONNECTIONS),
    connectionTimeoutMillis: numberOf(
      'DATABASE_POOL_ACQUIRE_TIMEOUT_MS',
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    ),
    statement_timeout: numberOf(
      'DATABASE_STATEMENT_TIMEOUT_MS',
      DEFAULT_STATEMENT_TIMEOUT_MS,
    ),
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}
