import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

import { NOTIFICATION_DRIVERS } from '../notifications/verification-code-sender';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const MIN_JWT_SECRET_LENGTH_IN_PRODUCTION = 64;
const MIN_PASSWORD_HASH_ROUNDS_IN_PRODUCTION = 12;
const MIN_METRICS_TOKEN_LENGTH = 32;
const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** Os fornecedores de pagamento que a aplicação conhece. */
export const PAYMENT_PROVIDERS = ['manual', 'simulator', 'mpesa'] as const;

const emptyAsMissing = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value;

/**
 * Variáveis de ambiente sem as quais a aplicação não deve arrancar.
 *
 * O Swagger, o mock-pay, o detalhe dos erros e o rate limit decidem-se pelo
 * NODE_ENV. Por isso só se aceitam os três valores do enum: um valor
 * desconhecido (ou a variável em falta) deixava essas protecções desligadas.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_CLOUD_NAME: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_KEY: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_SECRET: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  TRUST_PROXY_HOPS?: number;

  // Limites do pool de ligações à base (shared/db/pool-config.ts).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  DATABASE_POOL_MAX?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  DATABASE_POOL_ACQUIRE_TIMEOUT_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  DATABASE_STATEMENT_TIMEOUT_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  REFRESH_TOKEN_REUSE_GRACE_SECONDS?: number;

  // Custo do bcrypt para as passwords. Os testes baixam-no para correrem
  // depressa; em produção não pode ficar abaixo do valor por omissão.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(15)
  PASSWORD_HASH_ROUNDS?: number;

  @IsOptional()
  @IsIn(NOTIFICATION_DRIVERS)
  NOTIFICATIONS_DRIVER?: string;

  // O código compara estas duas com 'true', por isso validam-se como texto.
  @IsOptional()
  @IsIn(['true', 'false'])
  AUTO_APPROVE_EQUIPMENT?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  AUTO_APPROVE_SERVICES?: string;

  // Liga o chat em tempo real (socket em /chat). Sem a variável fica
  // desligado: a app usa o REST, e o socket só deve abrir quando for usado.
  @IsOptional()
  @IsIn(['true', 'false'])
  CHAT_GATEWAY_ENABLED?: string;

  // Quem confirma o dinheiro: manual (o admin, pelo extracto), simulator
  // (desenvolvimento e testes) ou mpesa. Sem a variável fica manual.
  @Transform(emptyAsMissing)
  @IsOptional()
  @IsIn(PAYMENT_PROVIDERS)
  PAYMENTS_PROVIDER?: string;

  // Segredo que o fornecedor envia em cada aviso. Sem ele, os avisos são
  // recusados.
  @Transform(emptyAsMissing)
  @IsOptional()
  @IsString()
  @MinLength(MIN_WEBHOOK_SECRET_LENGTH)
  PAYMENTS_WEBHOOK_SECRET?: string;

  // No modo manual, o número (ou código de comerciante) M-Pesa para onde o
  // cliente paga, e o nome que ele vê ao pagar. A app mostra-os.
  @Transform(emptyAsMissing)
  @IsOptional()
  @IsString()
  PAYMENTS_MANUAL_RECEIVER_NUMBER?: string;

  @Transform(emptyAsMissing)
  @IsOptional()
  @IsString()
  PAYMENTS_MANUAL_RECEIVER_NAME?: string;

  // Valor até ao qual um payout sai sozinho pelo fornecedor.
  @Transform(emptyAsMissing)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  PAYOUT_AUTO_MAX_AMOUNT?: number;

  // Com true, quem deu o dinheiro como entrado não aprova nem executa as
  // saídas desse pagamento.
  @Transform(emptyAsMissing)
  @IsOptional()
  @IsIn(['true', 'false'])
  MONEY_FOUR_EYES?: string;

  // Token que o scraper envia para ler /metrics. Vazio conta como ausente,
  // para o .env.example poder trazer a variável sem valor.
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(MIN_METRICS_TOKEN_LENGTH)
  METRICS_TOKEN?: string;
}

/** Regras que só valem em produção. Fora dela não há nada a apontar. */
function findUnsafeSettings(env: EnvironmentVariables): string[] {
  if (env.NODE_ENV !== NodeEnv.Production) {
    return [];
  }

  const problems: string[] = [];

  if (env.JWT_ACCESS_SECRET.length < MIN_JWT_SECRET_LENGTH_IN_PRODUCTION) {
    problems.push(
      `JWT_ACCESS_SECRET tem de ter pelo menos ${MIN_JWT_SECRET_LENGTH_IN_PRODUCTION} caracteres em produção`,
    );
  }

  if (
    env.PASSWORD_HASH_ROUNDS !== undefined &&
    env.PASSWORD_HASH_ROUNDS < MIN_PASSWORD_HASH_ROUNDS_IN_PRODUCTION
  ) {
    problems.push(
      `PASSWORD_HASH_ROUNDS não pode ser inferior a ${MIN_PASSWORD_HASH_ROUNDS_IN_PRODUCTION} em produção`,
    );
  }

  if (!env.METRICS_TOKEN) {
    problems.push(
      'METRICS_TOKEN é obrigatório em produção, porque o /metrics mostra o mapa de rotas e quanto dinheiro está no escrow',
    );
  }

  if (env.NOTIFICATIONS_DRIVER === 'log') {
    problems.push(
      'NOTIFICATIONS_DRIVER não pode ser log em produção, porque escreve os códigos de verificação no log',
    );
  }

  problems.push(...findUnsafePaymentSettings(env));

  for (const key of [
    'AUTO_APPROVE_EQUIPMENT',
    'AUTO_APPROVE_SERVICES',
  ] as const) {
    if (env[key] === 'true') {
      problems.push(
        `${key} não pode estar ligado em produção, porque publica anúncios sem moderação`,
      );
    }
  }

  return problems;
}

/** O que os pagamentos precisam em produção. */
function findUnsafePaymentSettings(env: EnvironmentVariables): string[] {
  const provider = env.PAYMENTS_PROVIDER ?? 'manual';
  const problems: string[] = [];

  if (provider === 'simulator') {
    problems.push(
      'PAYMENTS_PROVIDER não pode ser simulator em produção, porque dá pagamentos como recebidos sem dinheiro nenhum',
    );
  }

  if (provider !== 'manual' && !env.PAYMENTS_WEBHOOK_SECRET) {
    problems.push(
      'PAYMENTS_WEBHOOK_SECRET é obrigatório em produção com um fornecedor automático, porque é o que prova que um aviso de pagamento vem dele',
    );
  }

  if (provider === 'manual' && !env.PAYMENTS_MANUAL_RECEIVER_NUMBER) {
    problems.push(
      'PAYMENTS_MANUAL_RECEIVER_NUMBER é obrigatório em produção no modo manual, porque é o número para onde os clientes pagam',
    );
  }

  return problems;
}

/**
 * Função `validate` do ConfigModule. Lança no arranque, com todos os
 * problemas encontrados, em vez de deixar a aplicação subir mal configurada.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config);

  const invalidFields = validateSync(env).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
  const problems =
    invalidFields.length > 0 ? invalidFields : findUnsafeSettings(env);

  if (problems.length > 0) {
    const list = problems.map((problem) => `  - ${problem}`).join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${list}`);
  }

  return env;
}
