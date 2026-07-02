import { BadRequestException, Injectable } from '@nestjs/common';
import { LedgerDirection, LedgerParty, Prisma } from '@prisma/client';

import { roundMoney } from '../../../shared/constants/policy';

export type LedgerEntryInput = {
  paymentId: string;
  direction: LedgerDirection;
  party: LedgerParty;
  amount: number;
  reason: string;
  actorId?: string | null;
};

/**
 * Registo contabilístico imutável do escrow.
 *
 * Todas as escritas acontecem DENTRO da transacção do chamador (recebe o
 * Prisma.TransactionClient), para que o movimento contabilístico e a mudança
 * de estado sejam atómicos. Invariante central: a soma das saídas (OUTFLOW)
 * de um pagamento nunca pode exceder a soma das entradas (INFLOW).
 */
@Injectable()
export class LedgerService {
  async record(tx: Prisma.TransactionClient, entry: LedgerEntryInput) {
    const amount = roundMoney(entry.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Movimento contabilístico inválido: o valor deve ser positivo.',
      );
    }

    if (entry.direction === LedgerDirection.OUTFLOW) {
      const [inflow, outflow] = await Promise.all([
        tx.ledgerEntry.aggregate({
          where: {
            paymentId: entry.paymentId,
            direction: LedgerDirection.INFLOW,
          },
          _sum: { amount: true },
        }),
        tx.ledgerEntry.aggregate({
          where: {
            paymentId: entry.paymentId,
            direction: LedgerDirection.OUTFLOW,
          },
          _sum: { amount: true },
        }),
      ]);

      const available =
        Number(inflow._sum.amount ?? 0) - Number(outflow._sum.amount ?? 0);

      // Tolerância de meio centavo para absorver arredondamentos.
      if (amount > available + 0.005) {
        throw new BadRequestException(
          'Invariante do ledger violada: a saída excede o valor disponível no escrow deste pagamento.',
        );
      }
    }

    return tx.ledgerEntry.create({
      data: {
        paymentId: entry.paymentId,
        direction: entry.direction,
        party: entry.party,
        amount,
        reason: entry.reason,
        actorId: entry.actorId ?? null,
      },
    });
  }

  /** Regista várias entradas em sequência (mantém a validação da invariante entrada a entrada). */
  async recordMany(tx: Prisma.TransactionClient, entries: LedgerEntryInput[]) {
    for (const entry of entries) {
      await this.record(tx, entry);
    }
  }

  /** Saldo actual do escrow de um pagamento (entradas − saídas). */
  async balance(tx: Prisma.TransactionClient, paymentId: string) {
    const [inflow, outflow] = await Promise.all([
      tx.ledgerEntry.aggregate({
        where: { paymentId, direction: LedgerDirection.INFLOW },
        _sum: { amount: true },
      }),
      tx.ledgerEntry.aggregate({
        where: { paymentId, direction: LedgerDirection.OUTFLOW },
        _sum: { amount: true },
      }),
    ]);

    return roundMoney(
      Number(inflow._sum.amount ?? 0) - Number(outflow._sum.amount ?? 0),
    );
  }
}
