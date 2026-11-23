import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UploadServicePhotoDto } from './upload-service-photo.dto';

const SERVICE_ID = '7f1f3a52-6f0e-4f6e-9a4b-2c1d8e5b9a10';

// Num formulário multipart tudo chega como texto.
const read = (isPrimary: unknown) =>
  plainToInstance(UploadServicePhotoDto, { serviceId: SERVICE_ID, isPrimary });

describe('UploadServicePhotoDto', () => {
  it.each([
    ['false', false],
    ['true', true],
    [false, false],
    [true, true],
  ])('lê isPrimary %p como %p', (sent, expected) => {
    expect(read(sent).isPrimary).toBe(expected);
  });

  it('deixa isPrimary por definir quando não vem', async () => {
    const dto = read(undefined);

    expect(dto.isPrimary).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('recusa um valor que não é verdadeiro nem falso', async () => {
    const [error] = await validate(read('talvez'));

    expect(error.property).toBe('isPrimary');
  });
});
