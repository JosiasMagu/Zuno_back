import { Prisma } from '@prisma/client';

import { PrismaService } from './prisma.service';

/** Código com que o Prisma devolve uma transacção abortada por conflito de escrita. */
const SERIALIZATION_FAILURE = 'P2034';

/** O mesmo conflito, como o adaptador do Postgres o devolve sem o converter. */
const DRIVER_WRITE_CONFLICT = 'TransactionWriteConflict';

/**
 * O Postgres pode abortar uma transacção serializável numa escrita ou só no
 * COMMIT. No primeiro caso o Prisma devolve P2034. No segundo, o erro sai do
 * adaptador tal como veio do driver (SQLSTATE 40001), sem código do Prisma.
 * Os dois são o mesmo conflito e têm de dar a mesma resposta.
 */
export function isWriteConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === SERIALIZATION_FAILURE;
  }

  const cause = (error as { cause?: { kind?: unknown } } | null)?.cause;
  return cause?.kind === DRIVER_WRITE_CONFLICT;
}

/** Quantas vezes a transacção corre antes de o conflito chegar a quem chamou. */
const MAX_ATTEMPTS = 3;

/** Espera curta e desigual, para as duas transacções não voltarem a chocar. */
const backoffMs = (attempt: number) => attempt * 20 + Math.random() * 30;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Corre `work` numa transacção serializável.
 *
 * O Postgres aborta uma de duas transacções que mexem no mesmo estado ao mesmo
 * tempo e, em tabelas pequenas, também aborta transacções que não se tocam.
 * Por isso a que perdeu repete: relê o estado e ou passa ou recebe o erro de
 * negócio certo. Só ao fim de MAX_ATTEMPTS sai o erro de `onConflict`.
 *
 * `work` só pode mexer na base, e sempre por `tx`: é o que torna a repetição
 * segura.
 */
export async function runSerializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  onConflict: () => Error,
  timeoutMs = 5000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
      });
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      if (attempt === MAX_ATTEMPTS) throw onConflict();
      await pause(backoffMs(attempt));
    }
  }
}
