import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiOptions } from 'cloudinary';
import { Readable } from 'stream';

import { describeError } from '../scheduling/process-due';

/** Tamanho máximo de cada imagem enviada. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

const PHOTO: UploadApiOptions = {
  transformation: [
    { width: 1200, crop: 'limit' },
    { quality: 'auto' },
    { fetch_format: 'auto' },
  ],
};

const AVATAR: UploadApiOptions = {
  transformation: [
    { width: 400, height: 400, crop: 'fill', gravity: 'face' },
    { quality: 'auto' },
    { fetch_format: 'auto' },
  ],
};

/** As imagens privadas guardam-se todas neste formato, para o endereço não depender do que foi enviado. */
const PRIVATE_FORMAT = 'jpg';

const avatarId = (userId: string) => `zuno/avatars/${userId}`;

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  async uploadEquipmentPhoto(
    file: Express.Multer.File,
    equipmentId: string,
  ): Promise<{ url: string; publicId: string }> {
    return this.upload(file, {
      ...PHOTO,
      folder: `zuno/equipment/${equipmentId}`,
    });
  }

  async uploadServicePhoto(
    file: Express.Multer.File,
    serviceId: string,
  ): Promise<{ url: string; publicId: string }> {
    return this.upload(file, {
      ...PHOTO,
      folder: `zuno/services/${serviceId}`,
    });
  }

  async uploadDisputeEvidence(
    file: Express.Multer.File,
    disputeId: string,
  ): Promise<{ url: string; publicId: string }> {
    return this.upload(file, {
      ...PHOTO,
      folder: `zuno/disputes/${disputeId}`,
    });
  }

  /**
   * Cada conta tem um avatar, sempre no mesmo sítio: o novo substitui o
   * anterior e não ficam fotos antigas por apagar. O endereço muda a cada
   * envio, porque leva a versão.
   */
  async uploadAvatar(file: Express.Multer.File, userId: string) {
    const { url } = await this.upload(file, {
      ...AVATAR,
      public_id: avatarId(userId),
      overwrite: true,
      invalidate: true,
    });
    return { url };
  }

  async deleteAvatar(userId: string): Promise<void> {
    await this.destroy(avatarId(userId), { invalidate: true });
  }

  /**
   * Guarda uma imagem que só se lê com endereço assinado. Devolve só o
   * identificador: o endereço pede-se a `privateImageUrl`, com validade.
   */
  async uploadPrivateImage(file: Express.Multer.File, folder: string) {
    const { publicId } = await this.upload(file, {
      folder,
      type: 'authenticated',
      format: PRIVATE_FORMAT,
      transformation: [{ width: 2000, crop: 'limit' }],
    });
    return { publicId };
  }

  /** Endereço de uma imagem privada, que deixa de servir em `expiresAt`. */
  privateImageUrl(publicId: string, expiresAt: Date): string {
    return cloudinary.utils.private_download_url(publicId, PRIVATE_FORMAT, {
      type: 'authenticated',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    });
  }

  async deletePrivateImages(publicIds: string[]): Promise<void> {
    await Promise.all(
      publicIds.map((publicId) =>
        this.destroy(publicId, { type: 'authenticated', invalidate: true }),
      ),
    );
  }

  async deletePhoto(publicId: string): Promise<void> {
    await this.destroy(publicId);
  }

  private async upload(
    file: Express.Multer.File,
    options: UploadApiOptions,
  ): Promise<{ url: string; publicId: string }> {
    this.validateFile(file);

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { ...options, resource_type: 'image' },
        (error, result) => {
          if (error || !result) {
            return reject(
              new BadRequestException(
                'Erro ao fazer upload da foto. Tenta novamente.',
              ),
            );
          }

          resolve({
            url: result.secure_url,
            publicId: result.public_id,
          });
        },
      );

      Readable.from(file.buffer).pipe(uploadStream);
    });
  }

  /**
   * Uma imagem que não se conseguiu apagar não desfaz a operação na base,
   * mas fica no log: pode ser um documento que devia ter saído.
   */
  private async destroy(
    publicId: string,
    options: { type?: 'authenticated'; invalidate?: boolean } = {},
  ): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, options);
    } catch (error) {
      this.logger.warn(
        `Não foi possível apagar a imagem ${publicId}: ${describeError(error)}`,
      );
    }
  }

  private validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('Nenhum ficheiro enviado.');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de ficheiro inválido. Aceites: JPEG, PNG, WEBP.',
      );
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        'Ficheiro demasiado grande. Tamanho máximo: 5MB.',
      );
    }
  }
}
