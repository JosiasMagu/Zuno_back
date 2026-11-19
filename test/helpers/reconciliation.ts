import { INestApplication } from '@nestjs/common';

import { ReconciliationService } from '../../src/modules/payments/services/reconciliation.service';

/**
 * Corre a reconciliação sobre o que o teste deixou na base e falha se o
 * ledger, os payouts, o estado do pagamento e a reserva não baterem certo.
 * Usa-se no `afterEach` dos testes que mexem em dinheiro: cada cenário passa
 * a provar também que não deixou o dinheiro mal contado.
 */
export async function expectMoneyReconciles(
  app: INestApplication,
): Promise<void> {
  const report = await app.get(ReconciliationService).run();

  expect(report.findings).toEqual([]);
}
