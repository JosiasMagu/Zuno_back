import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateUserDto } from './update-user.dto';

const CLOUD = 'zuno-testes';

const errorsFor = (avatarUrl: unknown) =>
  validate(plainToInstance(UpdateUserDto, { avatarUrl }));

describe('UpdateUserDto: avatarUrl', () => {
  const previousCloud = process.env.CLOUDINARY_CLOUD_NAME;

  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  });

  afterAll(() => {
    if (previousCloud === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = previousCloud;
    }
  });

  // Vazio é o pedido para tirar a foto, e não um endereço inválido.
  it.each(['', '   '])(
    'aceita %p, que tira a foto de perfil',
    async (empty) => {
      expect(await errorsFor(empty)).toHaveLength(0);
    },
  );

  it('aceita uma imagem do armazenamento da plataforma', async () => {
    const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1/zuno/avatars/u1.jpg`;

    expect(await errorsFor(url)).toHaveLength(0);
  });

  it('recusa um endereço de fora', async () => {
    const [error] = await errorsFor('https://exemplo.com/eu.png');

    expect(error.property).toBe('avatarUrl');
  });
});
