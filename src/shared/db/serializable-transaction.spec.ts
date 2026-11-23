import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from './prisma.service';
import { runSerializable } from './serializable-transaction';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('erro do Prisma', {
    code,
    clientVersion: 'teste',
  });

describe('runSerializable()', () => {
  const transaction = jest.fn();
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  const onConflict = () => new ConflictException('Tenta de novo.');

  beforeEach(() => transaction.mockReset());

  it('corre o trabalho numa transacção serializável e devolve o resultado', async () => {
    transaction.mockImplementation((work: (tx: unknown) => Promise<string>) =>
      work({}),
    );

    const result = await runSerializable(
      prisma,
      () => Promise.resolve('feito'),
      onConflict,
    );

    expect(result).toBe('feito');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 5000,
    });
  });

  it('troca o conflito de escrita do Postgres pelo erro de quem chamou', async () => {
    transaction.mockRejectedValue(prismaError('P2034'));

    await expect(
      runSerializable(prisma, () => Promise.resolve(), onConflict),
    ).rejects.toThrow(new ConflictException('Tenta de novo.'));
  });

  describe('repetição de quem perdeu a corrida', () => {
    it('repete a transacção e devolve o resultado da repetição', async () => {
      transaction
        .mockRejectedValueOnce(prismaError('P2034'))
        .mockResolvedValueOnce('feito à segunda');

      const result = await runSerializable(
        prisma,
        () => Promise.resolve('ignorado pelo mock'),
        onConflict,
      );

      expect(result).toBe('feito à segunda');
      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('desiste ao fim de três tentativas', async () => {
      transaction.mockRejectedValue(prismaError('P2034'));

      await expect(
        runSerializable(prisma, () => Promise.resolve(), onConflict),
      ).rejects.toThrow(ConflictException);
      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it('não repete um erro que não é conflito', async () => {
      transaction.mockRejectedValue(prismaError('P2002'));

      await expect(
        runSerializable(prisma, () => Promise.resolve(), onConflict),
      ).rejects.toThrow();
      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });

  it('trata do mesmo modo o conflito que o Postgres só dá no COMMIT', async () => {
    // No COMMIT o adaptador pg lança o erro do driver, sem código do Prisma.
    const atCommit = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TransactionWriteConflict' },
    });
    transaction.mockRejectedValue(atCommit);

    await expect(
      runSerializable(prisma, () => Promise.resolve(), onConflict),
    ).rejects.toThrow(new ConflictException('Tenta de novo.'));
  });

  it('não confunde outros erros do driver com um conflito', async () => {
    const connectionLost = Object.assign(new Error('ConnectionClosed'), {
      name: 'DriverAdapterError',
      cause: { kind: 'ConnectionClosed' },
    });
    transaction.mockRejectedValue(connectionLost);

    await expect(
      runSerializable(prisma, () => Promise.resolve(), onConflict),
    ).rejects.toBe(connectionLost);
  });

  it('deixa passar os outros erros tal como vieram', async () => {
    const uniqueViolation = prismaError('P2002');
    transaction.mockRejectedValue(uniqueViolation);

    await expect(
      runSerializable(prisma, () => Promise.resolve(), onConflict),
    ).rejects.toBe(uniqueViolation);
  });
});
