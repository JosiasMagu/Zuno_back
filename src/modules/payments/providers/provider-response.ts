import { Prisma } from '@prisma/client';

import { ProviderOutcome } from './payment-provider';

/**
 * A resposta do fornecedor como fica guardada na operação: o desfecho e o
 * corpo que o adaptador passou em `raw`. O adaptador é quem tira os
 * segredos antes de pôr alguma coisa em `raw`.
 */
export function toProviderResponse(
  outcome: ProviderOutcome,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(outcome)) as Prisma.InputJsonValue;
}
