import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Para quem não gere um anúncio fora do catálogo, ele não existe: a recusa
 * de `read` sai como 404, para a resposta não confirmar que o anúncio existe.
 */
export async function hideFromOutsiders<T>(
  read: () => Promise<T>,
  notFoundMessage: string,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ForbiddenException) {
      throw new NotFoundException(notFoundMessage);
    }
    throw error;
  }
}
