import { ReviewAuthorRole } from '@prisma/client';

/**
 * O papel do autor de uma avaliação, como a API o recebe.
 *
 * A app ainda envia `OWNER`, o nome que `PROVIDER` tinha antes de o enum
 * mudar, e a API aceita-o como `PROVIDER`. Qualquer outro valor segue como
 * veio, para a validação o recusar.
 */
export function toAuthorRole(value: unknown): unknown {
  return value === 'OWNER' ? ReviewAuthorRole.PROVIDER : value;
}
