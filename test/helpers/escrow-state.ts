import { getTestPrisma } from './db';

/** Saídas do escrow registadas no ledger, no formato "PARTE:valor". */
export async function readOutflows(paymentId: string): Promise<string[]> {
  const entries = await getTestPrisma().ledgerEntry.findMany({
    where: { paymentId, direction: 'OUTFLOW' },
    select: { party: true, amount: true },
  });

  return entries.map((e) => `${e.party}:${Number(e.amount)}`).sort();
}

/** Payouts criados para o pagamento, no formato "TIPO:valor:estado". */
export async function readPayouts(paymentId: string): Promise<string[]> {
  const payouts = await getTestPrisma().payout.findMany({
    where: { paymentId },
    select: { kind: true, amount: true, status: true },
  });

  return payouts.map((p) => `${p.kind}:${Number(p.amount)}:${p.status}`).sort();
}

/** Entradas no escrow registadas no ledger, no formato "PARTE:valor". */
export async function readInflows(paymentId: string): Promise<string[]> {
  const entries = await getTestPrisma().ledgerEntry.findMany({
    where: { paymentId, direction: 'INFLOW' },
    select: { party: true, amount: true },
  });

  return entries.map((e) => `${e.party}:${Number(e.amount)}`).sort();
}
