import { validate } from 'class-validator';

import { isProjectMediaUrl, IsProjectMediaUrl } from './project-media-url';

const CLOUD = 'zuno-teste';
const own = (path: string) =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/${path}`;

describe('isProjectMediaUrl', () => {
  it('aceita uma imagem no Cloudinary do projecto', () => {
    expect(isProjectMediaUrl(own('v1/zuno/avatars/a.jpg'), CLOUD)).toBe(true);
  });

  it.each([
    ['outro servidor', 'https://exemplo.com/avatar.png'],
    [
      'o Cloudinary de outra conta',
      'https://res.cloudinary.com/outra/image/upload/a.jpg',
    ],
    ['http em vez de https', own('a.jpg').replace('https', 'http')],
    ['um esquema que não é de imagem', 'javascript:alert(1)'],
    [
      'um servidor que só imita o nome',
      `https://res.cloudinary.com.exemplo.com/${CLOUD}/a.jpg`,
    ],
    ['texto que não é um endereço', 'avatar'],
  ])('recusa %s', (_label, url) => {
    expect(isProjectMediaUrl(url, CLOUD)).toBe(false);
  });
});

describe('@IsProjectMediaUrl', () => {
  class Profile {
    @IsProjectMediaUrl()
    avatarUrl!: unknown;
  }

  const errorsFor = async (avatarUrl: unknown) =>
    validate(Object.assign(new Profile(), { avatarUrl }));

  const previous = process.env.CLOUDINARY_CLOUD_NAME;
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  });
  afterAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = previous;
  });

  it('deixa passar uma imagem do projecto', async () => {
    expect(await errorsFor(own('a.jpg'))).toHaveLength(0);
  });

  it('recusa um link de fora, com uma mensagem que a app pode mostrar', async () => {
    const [error] = await errorsFor('https://exemplo.com/a.jpg');

    expect(error.constraints).toEqual({
      isProjectMediaUrl:
        'A imagem tem de estar no armazenamento da plataforma.',
    });
  });

  it('recusa o que não é texto', async () => {
    expect(await errorsFor(42)).toHaveLength(1);
  });
});
