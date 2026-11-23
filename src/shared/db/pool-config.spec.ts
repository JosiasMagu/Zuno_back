import { poolConfig } from './pool-config';

const URL = 'postgresql://zuno:segredo@localhost:5432/zuno_db';

const settingsOf = (values: Record<string, unknown> = {}) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

describe('poolConfig', () => {
  it('põe limites mesmo quando o ambiente não define nenhum', () => {
    expect(poolConfig(URL, settingsOf())).toEqual({
      connectionString: URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
  });

  it('usa os valores do ambiente, venham como número ou como texto', () => {
    const config = poolConfig(
      URL,
      settingsOf({
        DATABASE_POOL_MAX: 25,
        DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '2000',
        DATABASE_STATEMENT_TIMEOUT_MS: '8000',
      }),
    );

    expect(config).toMatchObject({
      max: 25,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 8_000,
    });
  });
});
