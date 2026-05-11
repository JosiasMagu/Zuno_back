import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { EquipmentPhotosService } from './equipment-photos.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';

const OWNER_ID = 'owner-uuid-001';
const ADMIN_ID = 'admin-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const PHOTO_ID = 'photo-uuid-001';

const makeUser = (id: string, role: UserRole) => ({ id, role });

const makeEquipment = (overrides: Record<string, unknown> = {}) => ({
  id: EQUIPMENT_ID,
  ownerId: OWNER_ID,
  status: 'ACTIVE',
  photos: [] as Array<{ id: string; order: number; isPrimary: boolean }>,
  ...overrides,
});

const makePhoto = (overrides: Record<string, unknown> = {}) => ({
  id: PHOTO_ID,
  equipmentId: EQUIPMENT_ID,
  url: 'https://cdn.example.com/photo.jpg',
  publicId: 'zuno/equipment/abc',
  isPrimary: false,
  order: 0,
  ...overrides,
});

const makeFile = (name = 'file.jpg'): Express.Multer.File =>
  ({
    fieldname: 'photo',
    originalname: name,
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('fake'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
  }) as Express.Multer.File;

const makePrismaMock = () => ({
  user: { findUnique: jest.fn() },
  equipment: { findUnique: jest.fn() },
  equipmentPhoto: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
});

const makeCloudinaryMock = () => ({
  uploadEquipmentPhoto: jest.fn(),
  deletePhoto: jest.fn(),
});

describe('EquipmentPhotosService', () => {
  let service: EquipmentPhotosService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let cloudinary: ReturnType<typeof makeCloudinaryMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    cloudinary = makeCloudinaryMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentPhotosService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
      ],
    }).compile();

    service = module.get<EquipmentPhotosService>(EquipmentPhotosService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadPhoto()', () => {
    it('lanca NotFoundException se equipamento nao existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadPhoto(OWNER_ID, EQUIPMENT_ID, makeFile()),
      ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
    });

    it('lanca NotFoundException se utilizador nao existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadPhoto(OWNER_ID, EQUIPMENT_ID, makeFile()),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('lanca ForbiddenException quando nao e owner nem admin', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(
        service.uploadPhoto(STRANGER_ID, EQUIPMENT_ID, makeFile()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita quando atinge o limite de 10 fotos', async () => {
      const photos = Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        order: i,
        isPrimary: i === 0,
      }));
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment({ photos }));
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(
        service.uploadPhoto(OWNER_ID, EQUIPMENT_ID, makeFile()),
      ).rejects.toThrow(BadRequestException);

      expect(cloudinary.uploadEquipmentPhoto).not.toHaveBeenCalled();
    });

    it('faz upload e marca como primaria quando e a primeira foto', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.uploadEquipmentPhoto.mockResolvedValue({
        url: 'https://cdn.example.com/new.jpg',
        publicId: 'zuno/equipment/new',
      });
      prisma.equipmentPhoto.create.mockResolvedValue(
        makePhoto({ isPrimary: true, order: 0 }),
      );

      const result = await service.uploadPhoto(
        OWNER_ID,
        EQUIPMENT_ID,
        makeFile(),
        false,
      );

      expect(result.data.isPrimary).toBe(true);
      expect(prisma.equipmentPhoto.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isPrimary: true, order: 0 }),
        }),
      );
    });

    it('quando isPrimary=true remove a flag das outras fotos antes de criar', async () => {
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({
          photos: [
            { id: 'p1', order: 0, isPrimary: true },
            { id: 'p2', order: 1, isPrimary: false },
          ],
        }),
      );
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.uploadEquipmentPhoto.mockResolvedValue({
        url: 'https://cdn.example.com/new.jpg',
        publicId: 'zuno/equipment/new',
      });
      prisma.equipmentPhoto.updateMany.mockResolvedValue({ count: 1 });
      prisma.equipmentPhoto.create.mockResolvedValue(
        makePhoto({ isPrimary: true, order: 2 }),
      );

      await service.uploadPhoto(OWNER_ID, EQUIPMENT_ID, makeFile(), true);

      expect(prisma.equipmentPhoto.updateMany).toHaveBeenCalledWith({
        where: { equipmentId: EQUIPMENT_ID, isPrimary: true },
        data: { isPrimary: false },
      });
    });

    it('ADMIN pode fazer upload em equipamento de outro owner', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(ADMIN_ID, UserRole.ADMIN),
      );
      cloudinary.uploadEquipmentPhoto.mockResolvedValue({
        url: 'https://cdn.example.com/admin.jpg',
        publicId: 'zuno/equipment/admin',
      });
      prisma.equipmentPhoto.create.mockResolvedValue(makePhoto());

      const result = await service.uploadPhoto(
        ADMIN_ID,
        EQUIPMENT_ID,
        makeFile(),
      );
      expect(result.message).toBe('Foto adicionada com sucesso.');
    });
  });

  describe('uploadMultiplePhotos()', () => {
    it('rejeita quando nao ha ficheiros', async () => {
      await expect(
        service.uploadMultiplePhotos(OWNER_ID, EQUIPMENT_ID, []),
      ).rejects.toThrow(new BadRequestException('Nenhum ficheiro enviado.'));
    });

    it('rejeita mais de 5 ficheiros num unico upload', async () => {
      const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.jpg`));

      await expect(
        service.uploadMultiplePhotos(OWNER_ID, EQUIPMENT_ID, files),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejeita quando ultrapassa o restante da capacidade do equipamento', async () => {
      const photos = Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        order: i,
      }));
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment({ photos }));
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];

      await expect(
        service.uploadMultiplePhotos(OWNER_ID, EQUIPMENT_ID, files),
      ).rejects.toThrow(BadRequestException);
    });

    it('faz upload paralelo e persiste em transacao', async () => {
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.uploadEquipmentPhoto
        .mockResolvedValueOnce({
          url: 'https://cdn.example.com/a.jpg',
          publicId: 'zuno/equipment/a',
        })
        .mockResolvedValueOnce({
          url: 'https://cdn.example.com/b.jpg',
          publicId: 'zuno/equipment/b',
        });
      prisma.$transaction.mockResolvedValue([
        makePhoto({ id: 'p1', isPrimary: true, order: 0 }),
        makePhoto({ id: 'p2', isPrimary: false, order: 1 }),
      ]);

      const result = await service.uploadMultiplePhotos(
        OWNER_ID,
        EQUIPMENT_ID,
        [makeFile('a.jpg'), makeFile('b.jpg')],
      );

      expect(cloudinary.uploadEquipmentPhoto).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.data).toHaveLength(2);
    });
  });

  describe('setPrimary()', () => {
    it('lanca NotFoundException se foto nao pertence ao equipamento', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(null);

      await expect(
        service.setPrimary(OWNER_ID, EQUIPMENT_ID, PHOTO_ID),
      ).rejects.toThrow(new NotFoundException('Foto não encontrada.'));
    });

    it('lanca ForbiddenException quando nao e owner nem admin', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(makePhoto());
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(
        service.setPrimary(STRANGER_ID, EQUIPMENT_ID, PHOTO_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('limpa primary das outras e marca a seleccionada em transacao', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(makePhoto());
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.$transaction.mockResolvedValue([{ count: 1 }, makePhoto()]);

      const result = await service.setPrimary(OWNER_ID, EQUIPMENT_ID, PHOTO_ID);

      expect(result.data.isPrimary).toBe(true);
      const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(ops).toHaveLength(2);
    });
  });

  describe('deletePhoto()', () => {
    it('lanca NotFoundException se foto nao existe', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(null);

      await expect(
        service.deletePhoto(OWNER_ID, EQUIPMENT_ID, PHOTO_ID),
      ).rejects.toThrow(new NotFoundException('Foto não encontrada.'));
    });

    it('lanca ForbiddenException sem permissao', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(makePhoto());
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(STRANGER_ID, UserRole.CLIENT),
      );

      await expect(
        service.deletePhoto(STRANGER_ID, EQUIPMENT_ID, PHOTO_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('apaga no Cloudinary quando ha publicId e remove da BD', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(makePhoto());
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.deletePhoto.mockResolvedValue(undefined);
      prisma.equipmentPhoto.delete.mockResolvedValue(makePhoto());

      await service.deletePhoto(OWNER_ID, EQUIPMENT_ID, PHOTO_ID);

      expect(cloudinary.deletePhoto).toHaveBeenCalledWith('zuno/equipment/abc');
      expect(prisma.equipmentPhoto.delete).toHaveBeenCalledWith({
        where: { id: PHOTO_ID },
      });
    });

    it('nao chama Cloudinary quando publicId esta ausente', async () => {
      prisma.equipmentPhoto.findFirst.mockResolvedValue(
        makePhoto({ publicId: null }),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipmentPhoto.delete.mockResolvedValue(makePhoto());

      await service.deletePhoto(OWNER_ID, EQUIPMENT_ID, PHOTO_ID);

      expect(cloudinary.deletePhoto).not.toHaveBeenCalled();
    });

    it('promove a proxima foto a primaria quando a apagada era primary', async () => {
      prisma.equipmentPhoto.findFirst
        .mockResolvedValueOnce(makePhoto({ isPrimary: true }))
        .mockResolvedValueOnce(makePhoto({ id: 'next-photo', order: 1 }));
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.deletePhoto.mockResolvedValue(undefined);
      prisma.equipmentPhoto.delete.mockResolvedValue(makePhoto());
      prisma.equipmentPhoto.update.mockResolvedValue(makePhoto());

      await service.deletePhoto(OWNER_ID, EQUIPMENT_ID, PHOTO_ID);

      expect(prisma.equipmentPhoto.update).toHaveBeenCalledWith({
        where: { id: 'next-photo' },
        data: { isPrimary: true },
      });
    });

    it('nao tenta promover quando nao existe proxima foto', async () => {
      prisma.equipmentPhoto.findFirst
        .mockResolvedValueOnce(makePhoto({ isPrimary: true }))
        .mockResolvedValueOnce(null);
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      cloudinary.deletePhoto.mockResolvedValue(undefined);
      prisma.equipmentPhoto.delete.mockResolvedValue(makePhoto());

      await service.deletePhoto(OWNER_ID, EQUIPMENT_ID, PHOTO_ID);

      expect(prisma.equipmentPhoto.update).not.toHaveBeenCalled();
    });
  });

  describe('listPhotos()', () => {
    it('lanca NotFoundException se equipamento nao existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(service.listPhotos(EQUIPMENT_ID)).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado.'),
      );
    });

    it('devolve fotos ordenadas com primary primeiro depois por order asc', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: EQUIPMENT_ID });
      prisma.equipmentPhoto.findMany.mockResolvedValue([
        makePhoto({ id: 'p1', isPrimary: true, order: 0 }),
        makePhoto({ id: 'p2', isPrimary: false, order: 1 }),
      ]);

      const result = await service.listPhotos(EQUIPMENT_ID);

      expect(result.data).toHaveLength(2);
      expect(prisma.equipmentPhoto.findMany).toHaveBeenCalledWith({
        where: { equipmentId: EQUIPMENT_ID },
        orderBy: [{ isPrimary: 'desc' }, { order: 'asc' }],
      });
    });
  });
});
