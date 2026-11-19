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

/**
 * Corre `work` numa transacção serializável.
 *
 * Quando duas transacções mexem no mesmo estado ao mesmo tempo, o Postgres
 * aborta uma delas. Quem perdeu a corrida recebe o erro de `onConflict`, em
 * vez de um 500.
 */
export async function runSerializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  onConflict: () => Error,
  timeoutMs = 5000,
): Promise<T> {
  try {
    return await prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: timeoutMs,
    });
  } catch (error) {
    if (isWriteConflict(error)) {
      throw onConflict();
    }
    throw error;
  }
}
