import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditAction, DocumentType, VerificationStatus } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { IDENTITY_DOCUMENT_LINK_MINUTES } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { VerificationsService } from './verifications.service';

const USER_ID = 'user-1';
const ADMIN_ID = 'admin-1';
const VERIFICATION_ID = 'verification-1';

const own = (name: string) => `zuno/kyc/${USER_ID}/${name}`;

const makeVerification = (overrides: Record<string, unknown> = {}) => ({
  id: VERIFICATION_ID,
  userId: USER_ID,
  status: VerificationStatus.PENDING,
  documentType: DocumentType.BI,
  documentFrontId: own('frente'),
  documentBackId: own('verso'),
  selfieId: own('selfie'),
  submittedAt: new Date('2026-11-23T10:00:00Z'),
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
  ...overrides,
});

const submission = {
  documentType: DocumentType.BI,
  documentFrontId: own('frente'),
  documentBackId: own('verso'),
  selfieId: own('selfie'),
};

describe('VerificationsService', () => {
  let service: VerificationsService;

  const prisma = {
    userVerification: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
    work(prisma),
  );
  const audit = { record: jest.fn() };
  const cloudinary = {
    uploadPrivateImage: jest.fn(),
    privateImageUrl: jest.fn(
      (publicId: string) => `https://assinado.exemplo/${publicId}`,
    ),
    deletePrivateImages: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: CloudinaryService, useValue: cloudinary },
      ],
    }).compile();
    service = module.get(VerificationsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadDocument()', () => {
    const photo = { buffer: Buffer.from('bi') } as Express.Multer.File;

    it('guarda a foto na pasta privada da conta e devolve o identificador', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(null);
      cloudinary.uploadPrivateImage.mockResolvedValue({
        publicId: own('frente'),
      });

      const result = await service.uploadDocument(USER_ID, photo);

      expect(cloudinary.uploadPrivateImage).toHaveBeenCalledWith(
        photo,
        `zuno/kyc/${USER_ID}`,
      );
      expect(result.data).toEqual({ documentId: own('frente') });
    });

    it.each([VerificationStatus.VERIFIED, VerificationStatus.PENDING])(
      'recusa, sem gastar armazenamento, a conta com a verificação %s',
      async (status) => {
        prisma.userVerification.findUnique.mockResolvedValue(
          makeVerification({ status }),
        );

        await expect(service.uploadDocument(USER_ID, photo)).rejects.toThrow(
          BadRequestException,
        );
        expect(cloudinary.uploadPrivateImage).not.toHaveBeenCalled();
      },
    );
  });

  describe('submit()', () => {
    it('cria a verificação com os identificadores dos documentos', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(null);
      prisma.userVerification.create.mockResolvedValue(makeVerification());

      const result = await service.submit(USER_ID, submission);

      expect(prisma.userVerification.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, ...submission },
      });
      expect(result.data.status).toBe(VerificationStatus.PENDING);
      expect(cloudinary.deletePrivateImages).not.toHaveBeenCalled();
    });

    it('aceita o passaporte sem verso', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(null);
      prisma.userVerification.create.mockResolvedValue(makeVerification());

      await service.submit(USER_ID, {
        documentType: DocumentType.PASSAPORTE,
        documentFrontId: own('frente'),
        selfieId: own('selfie'),
      });

      expect(prisma.userVerification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ documentBackId: null }) as object,
      });
    });

    it.each([
      ['o documento de outra conta', 'zuno/kyc/user-2/frente'],
      ['uma imagem pública do projecto', 'zuno/equipment/abc/foto'],
      ['um endereço', 'https://res.cloudinary.com/zuno/bi.jpg'],
    ])('recusa %s, sem gravar nada', async (_label, documentFrontId) => {
      prisma.userVerification.findUnique.mockResolvedValue(null);

      await expect(
        service.submit(USER_ID, { ...submission, documentFrontId }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userVerification.create).not.toHaveBeenCalled();
    });

    it('recusa a mesma foto em dois lugares', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(null);

      await expect(
        service.submit(USER_ID, { ...submission, selfieId: own('frente') }),
      ).rejects.toThrow('Cada foto tem de ser um carregamento diferente.');
    });

    it('depois de uma rejeição, volta a pendente e apaga os documentos substituídos', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(
        makeVerification({
          status: VerificationStatus.REJECTED,
          rejectionReason: 'Foto desfocada.',
        }),
      );
      prisma.userVerification.update.mockResolvedValue(makeVerification());

      await service.submit(USER_ID, {
        ...submission,
        documentFrontId: own('frente-nova'),
      });

      expect(prisma.userVerification.update).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: expect.objectContaining({
          status: VerificationStatus.PENDING,
          documentFrontId: own('frente-nova'),
          rejectionReason: null,
        }) as object,
      });
      // O verso e a selfie foram reaproveitados e ficam.
      expect(cloudinary.deletePrivateImages).toHaveBeenCalledWith([
        own('frente'),
      ]);
    });
  });

  describe('viewDocuments()', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-23T12:00:00Z'));
    });

    afterEach(() => jest.useRealTimers());

    it('devolve endereços que expiram e deixa a consulta em auditoria', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(
        makeVerification({ documentBackId: null }),
      );

      const { data } = await service.viewDocuments(ADMIN_ID, VERIFICATION_ID);

      const expiresAt = new Date(
        Date.now() + IDENTITY_DOCUMENT_LINK_MINUTES * 60_000,
      );
      expect(data).toEqual({
        verificationId: VERIFICATION_ID,
        documentFront: `https://assinado.exemplo/${own('frente')}`,
        documentBack: null,
        selfie: `https://assinado.exemplo/${own('selfie')}`,
        expiresAt,
      });
      expect(cloudinary.privateImageUrl).toHaveBeenCalledWith(
        own('frente'),
        expiresAt,
      );
      expect(audit.record).toHaveBeenCalledWith(
        {
          action: AuditAction.USER_KYC_DOCUMENTS_VIEWED,
          actorId: ADMIN_ID,
          targetType: 'UserVerification',
          targetId: VERIFICATION_ID,
          metadata: { userId: USER_ID },
        },
        prisma,
      );
    });

    it('não mostra nada se a auditoria não ficar escrita', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(makeVerification());
      audit.record.mockRejectedValueOnce(new Error('base em baixo'));

      await expect(
        service.viewDocuments(ADMIN_ID, VERIFICATION_ID),
      ).rejects.toThrow('base em baixo');
      expect(cloudinary.privateImageUrl).not.toHaveBeenCalled();
    });

    it('responde 404 para uma verificação que não existe', async () => {
      prisma.userVerification.findUnique.mockResolvedValue(null);

      await expect(
        service.viewDocuments(ADMIN_ID, VERIFICATION_ID),
      ).rejects.toThrow(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
