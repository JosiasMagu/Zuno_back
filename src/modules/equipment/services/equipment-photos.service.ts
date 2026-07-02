import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';

// Maximo de fotos por equipamento
const MAX_PHOTOS_PER_EQUIPMENT = 10;

@Injectable()
export class EquipmentPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Upload de uma foto

  async uploadPhoto(
    userId: string,
    equipmentId: string,
    file: Express.Multer.File,
    isPrimary: boolean = false,
  ) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true,
        ownerId: true,
        status: true,
        photos: { select: { id: true, order: true, isPrimary: true } },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || equipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para adicionar fotos a este equipamento.',
      );
    }

    if (equipment.photos.length >= MAX_PHOTOS_PER_EQUIPMENT) {
      throw new BadRequestException(
        `Limite máximo de ${MAX_PHOTOS_PER_EQUIPMENT} fotos por equipamento atingido.`,
      );
    }

    // Faz upload ao Cloudinary
    const { url, publicId } = await this.cloudinary.uploadEquipmentPhoto(
      file,
      equipmentId,
    );

    // Calcula a proxima ordem
    const nextOrder =
      equipment.photos.length > 0
        ? Math.max(...equipment.photos.map((p) => p.order)) + 1
        : 0;

    // Se isPrimary, remove o isPrimary de todas as outras fotos
    if (isPrimary && equipment.photos.length > 0) {
      await this.prisma.equipmentPhoto.updateMany({
        where: { equipmentId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    // Se e a primeira foto, torna-a sempre primaria
    const shouldBePrimary = isPrimary || equipment.photos.length === 0;

    const photo = await this.prisma.equipmentPhoto.create({
      data: {
        equipmentId,
        url,
        isPrimary: shouldBePrimary,
        order: nextOrder,
        // Guardamos o publicId do Cloudinary para poder apagar depois
        // Nota: precisas de adicionar o campo publicId ao schema (ver instrucoes abaixo)
        publicId,
      },
    });

    return {
      message: 'Foto adicionada com sucesso.',
      data: {
        id: photo.id,
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      },
    };
  }

  // Upload multiplo (ate 5 fotos de uma vez)

  async uploadMultiplePhotos(
    userId: string,
    equipmentId: string,
    files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('Nenhum ficheiro enviado.');
    }

    if (files.length > 5) {
      throw new BadRequestException(
        'Máximo de 5 fotos por upload. Faz uploads separados para mais.',
      );
    }

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true,
        ownerId: true,
        photos: { select: { id: true, order: true } },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || equipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para adicionar fotos a este equipamento.',
      );
    }

    const currentCount = equipment.photos.length;
    const remaining = MAX_PHOTOS_PER_EQUIPMENT - currentCount;

    if (files.length > remaining) {
      throw new BadRequestException(
        `Só podes adicionar mais ${remaining} foto(s). O equipamento já tem ${currentCount}.`,
      );
    }

    // Calcula a ordem inicial
    const startOrder =
      currentCount > 0
        ? Math.max(...equipment.photos.map((p) => p.order)) + 1
        : 0;

    // Faz upload em paralelo ao Cloudinary
    const uploadResults = await Promise.all(
      files.map((file) =>
        this.cloudinary.uploadEquipmentPhoto(file, equipmentId),
      ),
    );

    // Guarda todas na base de dados
    const photos = await this.prisma.$transaction(
      uploadResults.map((result, index) =>
        this.prisma.equipmentPhoto.create({
          data: {
            equipmentId,
            url: result.url,
            publicId: result.publicId,
            // Primeira foto do lote e primaria se nao havia fotos antes
            isPrimary: currentCount === 0 && index === 0,
            order: startOrder + index,
          },
        }),
      ),
    );

    return {
      message: `${photos.length} foto(s) adicionada(s) com sucesso.`,
      data: photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }

  // Definir foto como primaria

  async setPrimary(userId: string, equipmentId: string, photoId: string) {
    const photo = await this.prisma.equipmentPhoto.findFirst({
      where: { id: photoId, equipmentId },
    });

    if (!photo) {
      throw new NotFoundException('Foto não encontrada.');
    }

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, ownerId: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || equipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException('Não tens permissão para esta operação.');
    }

    // Remove isPrimary de todas e define na seleccionada - dentro de transaccao
    await this.prisma.$transaction([
      this.prisma.equipmentPhoto.updateMany({
        where: { equipmentId, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.equipmentPhoto.update({
        where: { id: photoId },
        data: { isPrimary: true },
      }),
    ]);

    return {
      message: 'Foto principal definida com sucesso.',
      data: { id: photoId, isPrimary: true },
    };
  }

  // Apagar foto

  async deletePhoto(userId: string, equipmentId: string, photoId: string) {
    const photo = await this.prisma.equipmentPhoto.findFirst({
      where: { id: photoId, equipmentId },
    });

    if (!photo) {
      throw new NotFoundException('Foto não encontrada.');
    }

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, ownerId: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || equipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException('Não tens permissão para apagar esta foto.');
    }

    // Apaga no Cloudinary e na base de dados em paralelo
    await Promise.all([
      photo.publicId
        ? this.cloudinary.deletePhoto(photo.publicId)
        : Promise.resolve(),
      this.prisma.equipmentPhoto.delete({ where: { id: photoId } }),
    ]);

    // Se era a foto primaria, promove a proxima na ordem
    if (photo.isPrimary) {
      const nextPhoto = await this.prisma.equipmentPhoto.findFirst({
        where: { equipmentId },
        orderBy: { order: 'asc' },
      });

      if (nextPhoto) {
        await this.prisma.equipmentPhoto.update({
          where: { id: nextPhoto.id },
          data: { isPrimary: true },
        });
      }
    }

    return {
      message: 'Foto removida com sucesso.',
    };
  }

  // Listar fotos de um equipamento

  async listPhotos(equipmentId: string) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const photos = await this.prisma.equipmentPhoto.findMany({
      where: { equipmentId },
      orderBy: [{ isPrimary: 'desc' }, { order: 'asc' }],
    });

    return {
      message: 'Fotos obtidas com sucesso.',
      data: photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }
}
