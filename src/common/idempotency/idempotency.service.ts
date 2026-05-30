import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

import { PrismaService } from '../../shared/db/prisma.service';

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'in-progress' }
  | { status: 'mismatch' }
  | { status: 'replay'; response: { statusCode: number; body: unknown } };

/**
 * Persistência dos registos de idempotency. Encapsula:
 *  - cálculo de hash do request body
 *  - tentativa atómica de aquisição (lock optimista via @@unique)
 *  - completar com a resposta (status + body)
 *  - libertar quando a operação erra (permitir retry imediato)
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  hashRequestBody(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }

  /**
   * Tenta inserir um registo PENDING para a tripla (key, userId, endpoint).
   *
   *  - `acquired`     → primeira vez; o caller deve processar o handler
   *                     e chamar `complete()` quando terminar.
   *  - `replay`       → já existe registo com resposta cacheada; devolver-la.
   *  - `in-progress`  → outra requisição com a mesma key ainda está a executar.
   *  - `mismatch`     → key reutilizada com body diferente — recusar.
   */
  async tryAcquire(args: {
    key: string;
    userId: string;
    endpoint: string;
    requestHash: string;
    ttlHours: number;
  }): Promise<AcquireResult> {
    const expiresAt = new Date(Date.now() + args.ttlHours * 3600_000);

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: args.key,
          userId: args.userId,
          endpoint: args.endpoint,
          requestHash: args.requestHash,
          expiresAt,
          // responseStatus default = 0 ⇒ marca "PENDING/em curso"
        },
      });
      return { status: 'acquired' };
    } catch (err) {
      // Colisão na unique → registo já existe
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.idempotencyKey.findUnique({
          where: {
            key_userId_endpoint: {
              key: args.key,
              userId: args.userId,
              endpoint: args.endpoint,
            },
          },
        });

        if (!existing) {
          // race rara: outra request acabou de apagar — tratar como novo
          return { status: 'acquired' };
        }

        if (existing.requestHash !== args.requestHash) {
          return { status: 'mismatch' };
        }

        if (existing.responseStatus === 0) {
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
      throw err;
    }
  }

  async complete(args: {
    key: string;
    userId: string;
    endpoint: string;
    statusCode: number;
    body: unknown;
  }): Promise<void> {
    try {
      await this.prisma.idempotencyKey.update({
        where: {
          key_userId_endpoint: {
            key: args.key,
            userId: args.userId,
            endpoint: args.endpoint,
          },
        },
        data: {
          responseStatus: args.statusCode,
          responseBody: (args.body ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Logar mas não falhar — o operacional já foi feito
      this.logger.warn(
        `Failed to persist idempotency response for ${args.endpoint}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Libera o registo (apaga). Chamado quando o handler erra, para que
   * o cliente possa fazer retry imediato sem ficar preso até ao TTL.
   */
  async release(args: {
    key: string;
    userId: string;
    endpoint: string;
  }): Promise<void> {
    try {
      await this.prisma.idempotencyKey.delete({
        where: {
          key_userId_endpoint: {
            key: args.key,
            userId: args.userId,
            endpoint: args.endpoint,
          },
        },
      });
    } catch {
      // se não existe, nada a fazer
    }
  }
}
