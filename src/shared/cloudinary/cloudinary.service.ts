import { Injectable, BadRequestException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  // Tamanho maximo por ficheiro: 5MB
  private readonly MAX_SIZE_BYTES = 5 * 1024 * 1024;

  // Tipos aceites
  private readonly ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
  ];

  async uploadEquipmentPhoto(
    file: Express.Multer.File,
    equipmentId: string,
  ): Promise<{ url: string; publicId: string }> {
    this.validateFile(file);

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `zuno/equipment/${equipmentId}`,
          transformation: [
            // Redimensiona para maximo 1200px de largura mantendo proporcao
            { width: 1200, crop: 'limit' },
            // Qualidade automatica - Cloudinary optimiza o tamanho
            { quality: 'auto' },
            // Converte para webp para melhor performance no mobile
            { fetch_format: 'auto' },
          ],
          resource_type: 'image',
        },
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

      // Converte o buffer do Multer para stream e envia ao Cloudinary
      Readable.from(file.buffer).pipe(uploadStream);
    });
  }

  async deletePhoto(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch {
      // Falha silenciosa - se a foto ja nao existe no Cloudinary,
      // nao e motivo para rejeitar a operacao na base de dados
    }
  }

  private validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('Nenhum ficheiro enviado.');
    }

    if (!this.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de ficheiro inválido. Aceites: JPEG, PNG, WEBP.',
      );
    }

    if (file.size > this.MAX_SIZE_BYTES) {
      throw new BadRequestException(
        'Ficheiro demasiado grande. Tamanho máximo: 5MB.',
      );
    }
  }
}
