/**
 * Processa, lote a lote, tudo o que um job encontra vencido. Devolve quantos
 * itens tratou.
 *
 * `fetchBatch` recebe os ids já vistos nesta execução e devolve o lote
 * seguinte sem eles. Cada item é tentado uma só vez: o que falha fica para a
 * próxima execução do job, em vez de voltar a ocupar o lote e deixar os
 * outros à espera.
 *
 * Acaba sempre. Um lote que só traga itens já vistos é tratado como o fim,
 * mesmo que `fetchBatch` não respeite a lista que recebeu.
 */
export async function processDue<T extends { id: string }>(job: {
  fetchBatch: (seenIds: string[]) => Promise<T[]>;
  handle: (item: T) => Promise<void>;
  onFailure: (item: T, error: unknown) => void;
}): Promise<number> {
  const seenIds = new Set<string>();
  let handled = 0;

  for (;;) {
    const fetched = await job.fetchBatch([...seenIds]);
    const batch = fetched.filter((item) => !seenIds.has(item.id));

    if (batch.length === 0) {
      return handled;
    }

    for (const item of batch) {
      seenIds.add(item.id);

      try {
        await job.handle(item);
        handled += 1;
      } catch (error: unknown) {
        job.onFailure(item, error);
      }
    }
  }
}

/**
 * O texto de um erro apanhado, para o log. Há bibliotecas (o SDK do
 * Cloudinary) que rejeitam com um objecto simples em vez de um Error.
 */
export function describeError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}
