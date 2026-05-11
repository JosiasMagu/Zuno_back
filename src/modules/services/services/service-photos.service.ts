import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { PrismaService } from '../../../shared/db/prisma.service';

const MAX_PHOTOS_PER_SERVICE = 10;

@Injectable()
export class ServicePhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async uploadPhoto(
    userId: string,
    serviceId: string,
    file: Express.Multer.File,
    isPrimary = false,
  ) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        providerId: true,
        status: true,
        photos: { select: { id: true, order: true, isPrimary: true } },
      },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || service.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para adicionar fotos a este serviço.',
      );
    }

    if (service.photos.length >= MAX_PHOTOS_PER_SERVICE) {
      throw new BadRequestException(
        `Limite máximo de ${MAX_PHOTOS_PER_SERVICE} fotos por serviço atingido.`,
      );
    }

    const { url, publicId } = await this.cloudinary.uploadServicePhoto(
      file,
      serviceId,
    );

    const nextOrder =
      service.photos.length > 0
        ? Math.max(...service.photos.map((p) => p.order)) + 1
        : 0;

    if (isPrimary && service.photos.length > 0) {
      await this.prisma.servicePhoto.updateMany({
        where: { serviceId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const shouldBePrimary = isPrimary || service.photos.length === 0;

    const photo = await this.prisma.servicePhoto.create({
      data: {
        serviceId,
        url,
        isPrimary: shouldBePrimary,
        order: nextOrder,
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

  async uploadMultiplePhotos(
    userId: string,
    serviceId: string,
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

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        providerId: true,
        photos: { select: { id: true, order: true } },
      },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || service.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para adicionar fotos a este serviço.',
      );
    }

    const currentCount = service.photos.length;
    const remaining = MAX_PHOTOS_PER_SERVICE - currentCount;

    if (files.length > remaining) {
      throw new BadRequestException(
        `Só podes adicionar mais ${remaining} foto(s). O serviço já tem ${currentCount}.`,
      );
    }

    const startOrder =
      currentCount > 0
        ? Math.max(...service.photos.map((p) => p.order)) + 1
        : 0;

    const uploadResults = await Promise.all(
      files.map((file) => this.cloudinary.uploadServicePhoto(file, serviceId)),
    );

    const photos = await this.prisma.$transaction(
      uploadResults.map((result, index) =>
        this.prisma.servicePhoto.create({
          data: {
            serviceId,
            url: result.url,
            publicId: result.publicId,
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

  async setPrimary(userId: string, photoId: string) {
    const photo = await this.prisma.servicePhoto.findUnique({
      where: { id: photoId },
      select: { id: true, serviceId: true },
    });

    if (!photo) {
      throw new NotFoundException('Foto não encontrada.');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: photo.serviceId },
      select: { id: true, providerId: true },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || service.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException('Não tens permissão para esta operação.');
    }

    await this.prisma.$transaction([
      this.prisma.servicePhoto.updateMany({
        where: { serviceId: photo.serviceId, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.servicePhoto.update({
        where: { id: photoId },
        data: { isPrimary: true },
      }),
    ]);

    return {
      message: 'Foto principal definida com sucesso.',
      data: { id: photoId, isPrimary: true },
    };
  }

  async deletePhoto(userId: string, photoId: string) {
    const photo = await this.prisma.servicePhoto.findUnique({
      where: { id: photoId },
    });

    if (!photo) {
      throw new NotFoundException('Foto não encontrada.');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: photo.serviceId },
      select: { id: true, providerId: true },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || service.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException('Não tens permissão para apagar esta foto.');
    }

    await Promise.all([
      photo.publicId
        ? this.cloudinary.deletePhoto(photo.publicId)
        : Promise.resolve(),
      this.prisma.servicePhoto.delete({ where: { id: photoId } }),
    ]);

    if (photo.isPrimary) {
      const nextPhoto = await this.prisma.servicePhoto.findFirst({
        where: { serviceId: photo.serviceId },
        orderBy: { order: 'asc' },
      });

      if (nextPhoto) {
        await this.prisma.servicePhoto.update({
          where: { id: nextPhoto.id },
          data: { isPrimary: true },
        });
      }
    }

    return { message: 'Foto removida com sucesso.' };
  }
}
