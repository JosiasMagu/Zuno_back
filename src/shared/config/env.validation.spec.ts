import 'reflect-metadata';

import { validateEnv } from './env.validation';

const developmentEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/zuno_db',
  JWT_ACCESS_SECRET: 'access-secret',
  CLOUDINARY_CLOUD_NAME: 'cloud',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
};

const productionEnv = {
  ...developmentEnv,
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  METRICS_TOKEN: 'm'.repeat(32),
  PAYMENTS_MANUAL_RECEIVER_NUMBER: '840000000',
};

describe('validateEnv()', () => {
  it('aceita a configuração mínima de desenvolvimento', () => {
    expect(() => validateEnv(developmentEnv)).not.toThrow();
  });

  it('aceita a configuração mínima de produção', () => {
    expect(() => validateEnv(productionEnv)).not.toThrow();
  });

  describe('METRICS_TOKEN', () => {
    it('é obrigatório em produção', () => {
      const withoutToken = { ...productionEnv, METRICS_TOKEN: undefined };

      expect(() => validateEnv(withoutToken)).toThrow(
        /METRICS_TOKEN é obrigatório em produção/,
      );
    });

    it('vazio conta como ausente: passa em desenvolvimento e falha em produção', () => {
      expect(() =>
        validateEnv({ ...developmentEnv, METRICS_TOKEN: '' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...productionEnv, METRICS_TOKEN: '' }),
      ).toThrow(/METRICS_TOKEN é obrigatório em produção/);
    });

    it('recusa um token curto, em qualquer ambiente', () => {
      expect(() =>
        validateEnv({ ...developmentEnv, METRICS_TOKEN: 'curto' }),
      ).toThrow(/METRICS_TOKEN/);
    });
  });

  it('converte PORT e TRUST_PROXY_HOPS para número', () => {
    const env = validateEnv({
      ...developmentEnv,
      PORT: '3000',
      TRUST_PROXY_HOPS: '1',
    });

    expect(env.PORT).toBe(3000);
    expect(env.TRUST_PROXY_HOPS).toBe(1);
  });

  it('mantém as variáveis que não valida', () => {
    const env = validateEnv({ ...developmentEnv, LOG_LEVEL: 'debug' });

    expect(env).toHaveProperty('LOG_LEVEL', 'debug');
  });

  it.each([undefined, '', 'staging', 'prod'])(
    'recusa NODE_ENV=%p',
    (nodeEnv) => {
      expect(() =>
        validateEnv({ ...developmentEnv, NODE_ENV: nodeEnv }),
      ).toThrow(/NODE_ENV/);
    },
  );

  it.each([
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ])('recusa %s vazio ou em falta', (key) => {
    expect(() => validateEnv({ ...developmentEnv, [key]: '' })).toThrow(key);
    expect(() => validateEnv({ ...developmentEnv, [key]: undefined })).toThrow(
      key,
    );
  });

  it('lista todos os campos inválidos na mesma mensagem', () => {
    expect(() =>
      validateEnv({ ...developmentEnv, NODE_ENV: 'staging', DATABASE_URL: '' }),
    ).toThrow(/NODE_ENV[\s\S]*DATABASE_URL/);
  });

  it.each(['abc', '-1', '1.5'])('recusa TRUST_PROXY_HOPS=%p', (hops) => {
    expect(() =>
      validateEnv({ ...developmentEnv, TRUST_PROXY_HOPS: hops }),
    ).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('aceita REFRESH_TOKEN_REUSE_GRACE_SECONDS a zero ou positivo', () => {
    const strict = validateEnv({
      ...developmentEnv,
      REFRESH_TOKEN_REUSE_GRACE_SECONDS: '0',
    });

    expect(strict.REFRESH_TOKEN_REUSE_GRACE_SECONDS).toBe(0);
  });

  it.each(['abc', '-1'])(
    'recusa REFRESH_TOKEN_REUSE_GRACE_SECONDS=%p',
    (seconds) => {
      expect(() =>
        validateEnv({
          ...developmentEnv,
          REFRESH_TOKEN_REUSE_GRACE_SECONDS: seconds,
        }),
      ).toThrow(/REFRESH_TOKEN_REUSE_GRACE_SECONDS/);
    },
  );

  it.each(['0', '70000', 'abc'])('recusa PORT=%p', (port) => {
    expect(() => validateEnv({ ...developmentEnv, PORT: port })).toThrow(
      /PORT/,
    );
  });

  it('recusa NOTIFICATIONS_DRIVER desconhecido', () => {
    expect(() =>
      validateEnv({ ...developmentEnv, NOTIFICATIONS_DRIVER: 'sms' }),
    ).toThrow(/NOTIFICATIONS_DRIVER/);
  });

  describe('em produção', () => {
    it('recusa JWT_ACCESS_SECRET com menos de 64 caracteres', () => {
      expect(() =>
        validateEnv({ ...productionEnv, JWT_ACCESS_SECRET: 'x'.repeat(63) }),
      ).toThrow(/JWT_ACCESS_SECRET tem de ter pelo menos 64 caracteres/);
    });

    it('recusa PASSWORD_HASH_ROUNDS abaixo de 12', () => {
      expect(() =>
        validateEnv({ ...productionEnv, PASSWORD_HASH_ROUNDS: '10' }),
      ).toThrow(/PASSWORD_HASH_ROUNDS não pode ser inferior a 12/);
    });

    it('aceita PASSWORD_HASH_ROUNDS a partir de 12', () => {
      expect(() =>
        validateEnv({ ...productionEnv, PASSWORD_HASH_ROUNDS: '13' }),
      ).not.toThrow();
    });

    it('recusa NOTIFICATIONS_DRIVER=log', () => {
      expect(() =>
        validateEnv({ ...productionEnv, NOTIFICATIONS_DRIVER: 'log' }),
      ).toThrow(/NOTIFICATIONS_DRIVER não pode ser log em produção/);
    });

    it('aceita NOTIFICATIONS_DRIVER=silent', () => {
      expect(() =>
        validateEnv({ ...productionEnv, NOTIFICATIONS_DRIVER: 'silent' }),
      ).not.toThrow();
    });

    it.each(['AUTO_APPROVE_EQUIPMENT', 'AUTO_APPROVE_SERVICES'])(
      'recusa %s ligado',
      (key) => {
        expect(() => validateEnv({ ...productionEnv, [key]: 'true' })).toThrow(
          new RegExp(`${key} não pode estar ligado em produção`),
        );
      },
    );

    describe('pagamentos', () => {
      const webhookSecret = 'w'.repeat(32);

      it('recusa o simulador', () => {
        expect(() =>
          validateEnv({
            ...productionEnv,
            PAYMENTS_PROVIDER: 'simulator',
            PAYMENTS_WEBHOOK_SECRET: webhookSecret,
          }),
        ).toThrow(/PAYMENTS_PROVIDER não pode ser simulator em produção/);
      });

      it('no modo manual, exige o número para onde os clientes pagam', () => {
        const env: Record<string, unknown> = { ...productionEnv };
        delete env.PAYMENTS_MANUAL_RECEIVER_NUMBER;

        expect(() => validateEnv(env)).toThrow(
          /PAYMENTS_MANUAL_RECEIVER_NUMBER é obrigatório em produção no modo manual/,
        );
      });

      it('com um fornecedor automático, exige o segredo dos avisos', () => {
        expect(() =>
          validateEnv({ ...productionEnv, PAYMENTS_PROVIDER: 'mpesa' }),
        ).toThrow(/PAYMENTS_WEBHOOK_SECRET é obrigatório em produção/);
      });

      it('aceita o M-Pesa com o segredo dos avisos', () => {
        expect(() =>
          validateEnv({
            ...productionEnv,
            PAYMENTS_PROVIDER: 'mpesa',
            PAYMENTS_WEBHOOK_SECRET: webhookSecret,
          }),
        ).not.toThrow();
      });

      it('recusa um segredo dos avisos curto, em qualquer ambiente', () => {
        expect(() =>
          validateEnv({
            ...developmentEnv,
            PAYMENTS_WEBHOOK_SECRET: 'curto',
          }),
        ).toThrow(/PAYMENTS_WEBHOOK_SECRET/);
      });

      it('recusa um fornecedor que não existe', () => {
        expect(() =>
          validateEnv({ ...developmentEnv, PAYMENTS_PROVIDER: 'emola' }),
        ).toThrow(/PAYMENTS_PROVIDER/);
      });
    });

    it('aceita AUTO_APPROVE_* desligado', () => {
      expect(() =>
        validateEnv({
          ...productionEnv,
          AUTO_APPROVE_EQUIPMENT: 'false',
          AUTO_APPROVE_SERVICES: 'false',
        }),
      ).not.toThrow();
    });
  });

  it('aceita um custo de bcrypt baixo fora de produção, para os testes', () => {
    const env = validateEnv({ ...developmentEnv, PASSWORD_HASH_ROUNDS: '4' });

    expect(env.PASSWORD_HASH_ROUNDS).toBe(4);
  });

  it.each(['3', '16', 'abc'])('recusa PASSWORD_HASH_ROUNDS=%p', (rounds) => {
    expect(() =>
      validateEnv({ ...developmentEnv, PASSWORD_HASH_ROUNDS: rounds }),
    ).toThrow(/PASSWORD_HASH_ROUNDS/);
  });

  it('aceita NOTIFICATIONS_DRIVER=log fora de produção', () => {
    expect(() =>
      validateEnv({ ...developmentEnv, NOTIFICATIONS_DRIVER: 'log' }),
    ).not.toThrow();
  });

  it('aceita AUTO_APPROVE_* ligado fora de produção', () => {
    expect(() =>
      validateEnv({ ...developmentEnv, AUTO_APPROVE_EQUIPMENT: 'true' }),
    ).not.toThrow();
  });
});
