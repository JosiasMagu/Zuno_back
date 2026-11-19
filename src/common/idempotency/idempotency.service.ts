import { Injectable, Logger } from '@nestjs/common';
import { IdempotencyKey, Prisma } from '@prisma/client';
import { createHash } from 'crypto';

import { PrismaService } from '../../shared/db/prisma.service';

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'in-progress' }
  | { status: 'mismatch' }
  | { status: 'replay'; response: { statusCode: number; body: unknown } };

/** O que identifica um pedido idempotente: a chave, quem a enviou e o recurso. */
export interface IdempotentRequest {
  key: string;
  userId: string;
  /** Método e caminho real do pedido, com os ids, sem a query string. */
  endpoint: string;
}

/**
 * Tempo que um pedido tem para acabar. Um registo "em curso" mais velho do
 * que isto ficou órfão: o processo morreu a meio, ou não conseguiu guardar a
 * resposta. A partir daí deixa de bloquear a chave e um novo pedido volta a
 * executar. A operação pode ter chegado a acontecer, por isso quem usa
 * idempotência continua a precisar das suas próprias verificações de estado.
 */
export const IN_PROGRESS_LEASE_MS = 60_000;

const HOUR_MS = 3_600_000;
const COMPLETE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

/** Marca de "em curso": o registo existe e ainda não tem resposta guardada. */
const IN_PROGRESS = 0;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** O mesmo objecto com as chaves por ordem, para dar sempre o mesmo hash. */
function withSortedKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? {};
  }

  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, source[key]]),
  );
}

/**
 * Registos de idempotência: guardam a resposta de um pedido para a repetir
 * quando o cliente volta a enviá-lo com a mesma chave.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Impressão digital do que o pedido traz: os parâmetros da query e o corpo. */
  hashRequest(body: unknown, query: unknown = {}): string {
    return createHash('sha256')
      .update(
        JSON.stringify({ query: withSortedKeys(query), body: body ?? {} }),
      )
      .digest('hex');
  }

  /**
   * Tenta ficar com a chave para este pedido.
   *
   *  - `acquired`: o pedido corre, e quem chama guarda a resposta com `complete()`.
   *  - `replay`: o pedido já correu, e devolve-se a resposta guardada.
   *  - `in-progress`: outro pedido com a mesma chave ainda está a correr.
   *  - `mismatch`: a chave já foi usada com outros dados.
   */
  async tryAcquire(
    args: IdempotentRequest & { requestHash: string; ttlHours: number },
  ): Promise<AcquireResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + args.ttlHours * HOUR_MS);

    if (await this.insert(args, expiresAt)) {
      return { status: 'acquired' };
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: this.identify(args),
    });

    // O pedido que tinha a chave falhou e libertou-a entre a colisão e esta
    // leitura. Tenta-se outra vez, e se outro chegar primeiro, espera-se.
    if (!existing) {
      return (await this.insert(args, expiresAt))
        ? { status: 'acquired' }
        : { status: 'in-progress' };
    }

    if (this.isAbandoned(existing, now)) {
      return (await this.takeOver(existing, args.requestHash, now, expiresAt))
        ? { status: 'acquired' }
        : { status: 'in-progress' };
    }

    if (existing.requestHash !== args.requestHash) {
      return { status: 'mismatch' };
    }

    if (existing.responseStatus === IN_PROGRESS) {
      return { status: 'in-progress' };
    }

    return {
      status: 'replay',
      response: {
        statusCode: existing.responseStatus,
        body: existing.responseBody,
      },
    };
  }

  /**
   * Guarda a resposta do pedido. Insiste algumas vezes, porque sem ela a
   * chave fica "em curso" até o prazo de `IN_PROGRESS_LEASE_MS` passar.
   * Nunca lança: a operação já foi feita e a resposta segue para o cliente.
   */
  async complete(
    args: IdempotentRequest & { statusCode: number; body: unknown },
  ): Promise<void> {
    for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt++) {
      try {
        await this.prisma.idempotencyKey.update({
          where: this.identify(args),
          data: {
            responseStatus: args.statusCode,
            responseBody: (args.body ??
              Prisma.JsonNull) as Prisma.InputJsonValue,
          },
        });
        return;
      } catch (error) {
        if (attempt === COMPLETE_ATTEMPTS) {
          this.logger.error(
            `Não foi possível guardar a resposta de ${args.endpoint}. A chave fica bloqueada durante ${IN_PROGRESS_LEASE_MS / 1000} segundos.`,
            error instanceof Error ? error.stack : String(error),
          );
          return;
        }
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }

  /**
   * Liberta a chave quando o pedido falha, para o cliente poder tentar de
   * novo logo a seguir. Se não conseguir, o prazo de "em curso" liberta-a.
   */
  async release(args: IdempotentRequest): Promise<void> {
    try {
      await this.prisma.idempotencyKey.delete({ where: this.identify(args) });
    } catch (error) {
      this.logger.warn(
        `Não foi possível libertar a chave de ${args.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Apaga os registos fora de prazo. Devolve quantos apagou. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }

  private identify(args: IdempotentRequest) {
    return {
      key_userId_endpoint: {
        key: args.key,
        userId: args.userId,
        endpoint: args.endpoint,
      },
    };
  }

  /** Cria o registo "em curso". Devolve false se a chave já existe. */
  private async insert(
    args: IdempotentRequest & { requestHash: string },
    expiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: args.key,
          userId: args.userId,
          endpoint: args.endpoint,
          requestHash: args.requestHash,
          expiresAt,
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Um registo fora de prazo, ou "em curso" há mais tempo do que um pedido demora. */
  private isAbandoned(record: IdempotencyKey, now: Date): boolean {
    const expired = record.expiresAt <= now;
    const leaseIsOver =
      record.responseStatus === IN_PROGRESS &&
      now.getTime() - record.createdAt.getTime() > IN_PROGRESS_LEASE_MS;

    return expired || leaseIsOver;
  }

  /**
   * Fica com um registo abandonado para um pedido novo. A condição repete o
   * que foi lido: se outro pedido ficou com ele primeiro, este espera.
   */
  private async takeOver(
    record: IdempotencyKey,
    requestHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: {
        id: record.id,
        createdAt: record.createdAt,
        responseStatus: record.responseStatus,
      },
      data: {
        requestHash,
        responseStatus: IN_PROGRESS,
        responseBody: Prisma.JsonNull,
        createdAt: now,
        expiresAt,
      },
    });

    return count === 1;
  }
}
