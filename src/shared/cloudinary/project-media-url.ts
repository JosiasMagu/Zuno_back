import { ValidateBy, ValidationOptions } from 'class-validator';

const CLOUDINARY_HOST = 'res.cloudinary.com';

/**
 * Um endereço de imagem só vale se estiver no Cloudinary do projecto.
 *
 * Com um link de fora, quem o pôs registava o IP de quem vê a imagem e podia
 * trocá-la depois de moderada.
 */
export function isProjectMediaUrl(url: string, cloudName: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === CLOUDINARY_HOST &&
    parsed.pathname.startsWith(`/${cloudName}/`)
  );
}

/** Valida um campo de DTO com `isProjectMediaUrl`. */
export function IsProjectMediaUrl(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isProjectMediaUrl',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          isProjectMediaUrl(value, process.env.CLOUDINARY_CLOUD_NAME ?? ''),
        defaultMessage: () =>
          'A imagem tem de estar no armazenamento da plataforma.',
      },
    },
    options,
  );
}
