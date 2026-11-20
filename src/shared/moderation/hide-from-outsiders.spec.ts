import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { hideFromOutsiders } from './hide-from-outsiders';

const NOT_FOUND = 'Anúncio não encontrado.';

describe('hideFromOutsiders', () => {
  it('devolve o que foi lido a quem gere o anúncio', async () => {
    const listing = { id: 'anuncio-1' };

    await expect(
      hideFromOutsiders(() => Promise.resolve(listing), NOT_FOUND),
    ).resolves.toBe(listing);
  });

  it('troca a recusa por 404, com a mensagem de quem chama', async () => {
    const refused = () => Promise.reject(new ForbiddenException());

    await expect(hideFromOutsiders(refused, NOT_FOUND)).rejects.toThrow(
      new NotFoundException(NOT_FOUND),
    );
  });

  it('deixa passar os outros erros como vieram', async () => {
    const failure = new BadRequestException('Pedido inválido.');

    await expect(
      hideFromOutsiders(() => Promise.reject(failure), NOT_FOUND),
    ).rejects.toBe(failure);
  });
});
