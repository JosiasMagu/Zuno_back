import { describeError, processDue } from './process-due';

interface Item {
  id: string;
}

/** Uma fila de itens vencidos: devolve, dois a dois, os que ainda não foram vistos. */
function queueOf(ids: string[]) {
  return jest.fn(
    (seenIds: string[]): Promise<Item[]> =>
      Promise.resolve(
        ids
          .filter((id) => !seenIds.includes(id))
          .slice(0, 2)
          .map((id) => ({ id })),
      ),
  );
}

describe('processDue()', () => {
  it('trata todos os itens vencidos, lote a lote', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);

    const handled = await processDue({
      fetchBatch: queueOf(['a', 'b', 'c', 'd', 'e']),
      handle,
      onFailure: jest.fn(),
    });

    expect(handled).toBe(5);
    expect(handle.mock.calls.map(([item]: [Item]) => item.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('o item que falha não impede os outros nem é tentado duas vezes', async () => {
    const handle = jest.fn((item: Item) =>
      item.id === 'a'
        ? Promise.reject(new Error('avariado'))
        : Promise.resolve(),
    );
    const onFailure = jest.fn();

    const handled = await processDue({
      fetchBatch: queueOf(['a', 'b', 'c']),
      handle,
      onFailure,
    });

    expect(handled).toBe(2);
    expect(handle).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledWith({ id: 'a' }, expect.any(Error));
  });

  it('acaba mesmo que um item tratado continue a aparecer como vencido', async () => {
    const stuck = jest.fn(
      (seenIds: string[]): Promise<Item[]> =>
        Promise.resolve(seenIds.includes('a') ? [] : [{ id: 'a' }]),
    );

    const handled = await processDue({
      fetchBatch: stuck,
      handle: jest.fn().mockResolvedValue(undefined),
      onFailure: jest.fn(),
    });

    expect(handled).toBe(1);
    expect(stuck).toHaveBeenCalledTimes(2);
  });

  it('acaba mesmo que a consulta ignore os ids já vistos', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);

    const handled = await processDue({
      fetchBatch: () => Promise.resolve([{ id: 'a' }, { id: 'b' }]),
      handle,
      onFailure: jest.fn(),
    });

    expect(handled).toBe(2);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('não faz nada quando não há nada vencido', async () => {
    const handle = jest.fn();

    const handled = await processDue({
      fetchBatch: queueOf([]),
      handle,
      onFailure: jest.fn(),
    });

    expect(handled).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('describeError()', () => {
  it('devolve a mensagem de um Error e o texto do resto', () => {
    expect(describeError(new Error('falhou'))).toBe('falhou');
    expect(describeError('texto solto')).toBe('texto solto');
  });
});
