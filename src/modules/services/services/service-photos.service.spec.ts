import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';

import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { ServicePhotosService } from './service-photos.service';

const PROVIDER_ID = 'provider-uuid';
const CLIENT_ID = 'client-uuid';
const SERVICE_ID = 'service-uuid';
const PHOTO_ID = 'photo-uuid';

const makeProvider = () => ({ id: PROVIDER_ID, role: UserRole.PROVIDER });
const makeClient = () => ({ id: CLIENT_ID, role: UserRole.CLIENT });

const makeFile = (): Express.Multer.File => ({
  fieldname: 'photo',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  size: 1024,
  buffer: Buffer.from('x'),
  destination: '',
  filename: '',
  path: '',
  stream: null as never,
});

const makePrisma = () => ({
  user: { findUnique: jest.fn() },
  service: { findUnique: jest.fn() },
  servicePhoto: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
});

const cloudinary = {
  uploadServicePhoto: jest.fn(),
  uploadEquipmentPhoto: jest.fn(),
  deletePhoto: jest.fn(),
};

describe('ServicePhotosService', () => {
  let service: ServicePhotosService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicePhotosService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
      ],
    }).compile();
    service = module.get(ServicePhotosService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadPhoto()', () => {
    it('PROVIDER faz upload — primeira foto torna-se primária', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: 'ACTIVE',
        photos: [],
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      cloudinary.uploadServicePhoto.mockResolvedValue({
        url: 'https://cdn/img.jpg',
        publicId: 'pid',
      });
      prisma.servicePhoto.create.mockResolvedValue({
        id: PHOTO_ID,
        url: 'https://cdn/img.jpg',
        isPrimary: true,
        order: 0,
      });

      const result = await service.uploadPhoto(
        PROVIDER_ID,
        SERVICE_ID,
        makeFile(),
      );
      expect(result.data.isPrimary).toBe(true);
    });

    it('rejeita não-dono', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: 'ACTIVE',
        photos: [],
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(
        service.uploadPhoto(CLIENT_ID, SERVICE_ID, makeFile()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita >10 fotos', async () => {
      const photos = Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        order: i,
        isPrimary: false,
      }));
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: 'ACTIVE',
        photos,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());

      await expect(
        service.uploadPhoto(PROVIDER_ID, SERVICE_ID, makeFile()),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('uploadMultiplePhotos()', () => {
    it('rejeita 0 ficheiros', async () => {
      await expect(
        service.uploadMultiplePhotos(PROVIDER_ID, SERVICE_ID, []),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita >5 ficheiros', async () => {
      const files = Array.from({ length: 6 }, () => makeFile());
      await expect(
        service.uploadMultiplePhotos(PROVIDER_ID, SERVICE_ID, files),
      ).rejects.toThrow(BadRequestException);
    });

    it('faz upload em batch com sucesso', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        photos: [],
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      cloudinary.uploadServicePhoto.mockResolvedValue({
        url: 'u',
        publicId: 'p',
      });
      prisma.$transaction.mockResolvedValue([
        { id: 'p1', url: 'u', isPrimary: true, order: 0 },
        { id: 'p2', url: 'u', isPrimary: false, order: 1 },
      ]);

      const result = await service.uploadMultiplePhotos(
        PROVIDER_ID,
        SERVICE_ID,
        [makeFile(), makeFile()],
      );
      expect(result.data).toHaveLength(2);
    });

    it('rejeita upload em batch que excederia o limite total', async () => {
      const photos = Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        order: i,
      }));
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        photos,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());

      await expect(
        service.uploadMultiplePhotos(PROVIDER_ID, SERVICE_ID, [
          makeFile(),
          makeFile(),
          makeFile(),
          makeFile(),
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita não-dono em batch upload', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        photos: [],
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(
        service.uploadMultiplePhotos(CLIENT_ID, SERVICE_ID, [makeFile()]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita serviço inexistente em batch', async () => {
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(
        service.uploadMultiplePhotos(PROVIDER_ID, SERVICE_ID, [makeFile()]),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('uploadPhoto() — branches adicionais', () => {
    it('rejeita serviço inexistente', async () => {
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(
        service.uploadPhoto(PROVIDER_ID, SERVICE_ID, makeFile()),
      ).rejects.toThrow(NotFoundException);
    });

    it('isPrimary=true desmarca outras primárias', async () => {
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
        status: 'ACTIVE',
        photos: [{ id: 'old', order: 0, isPrimary: true }],
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      cloudinary.uploadServicePhoto.mockResolvedValue({
        url: 'u',
        publicId: 'p',
      });
      prisma.servicePhoto.updateMany.mockResolvedValue({});
      prisma.servicePhoto.create.mockResolvedValue({
        id: 'new-photo',
        url: 'u',
        isPrimary: true,
        order: 1,
      });

      await service.uploadPhoto(PROVIDER_ID, SERVICE_ID, makeFile(), true);

      expect(prisma.servicePhoto.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { serviceId: SERVICE_ID, isPrimary: true },
          data: { isPrimary: false },
        }),
      );
    });
  });

  describe('setPrimary() / deletePhoto() — autorização', () => {
    it('setPrimary rejeita não-dono', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue({
        id: PHOTO_ID,
        serviceId: SERVICE_ID,
      });
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(service.setPrimary(CLIENT_ID, PHOTO_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('setPrimary: foto inexistente -> NotFound', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue(null);
      await expect(service.setPrimary(PROVIDER_ID, PHOTO_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletePhoto rejeita não-dono', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue({
        id: PHOTO_ID,
        serviceId: SERVICE_ID,
        isPrimary: false,
        publicId: null,
      });
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeClient());

      await expect(service.deletePhoto(CLIENT_ID, PHOTO_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('deletePhoto: foto inexistente -> NotFound', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue(null);
      await expect(service.deletePhoto(PROVIDER_ID, PHOTO_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setPrimary() / deletePhoto()', () => {
    it('setPrimary alterna isPrimary em transacção', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue({
        id: PHOTO_ID,
        serviceId: SERVICE_ID,
      });
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.setPrimary(PROVIDER_ID, PHOTO_ID);
      expect(result.data.isPrimary).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('deletePhoto apaga e promove próxima quando era primária', async () => {
      prisma.servicePhoto.findUnique.mockResolvedValue({
        id: PHOTO_ID,
        serviceId: SERVICE_ID,
        isPrimary: true,
        publicId: 'pid',
      });
      prisma.servicePhoto.findFirst.mockResolvedValue({ id: 'next-photo' });
      prisma.service.findUnique.mockResolvedValue({
        id: SERVICE_ID,
        providerId: PROVIDER_ID,
      });
      prisma.user.findUnique.mockResolvedValue(makeProvider());
      prisma.servicePhoto.delete.mockResolvedValue({});
      prisma.servicePhoto.update.mockResolvedValue({});

      const result = await service.deletePhoto(PROVIDER_ID, PHOTO_ID);
      expect(result.message).toBe('Foto removida com sucesso.');
      expect(cloudinary.deletePhoto).toHaveBeenCalledWith('pid');
      expect(prisma.servicePhoto.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { isPrimary: true },
        }),
      );
    });
  });
});
