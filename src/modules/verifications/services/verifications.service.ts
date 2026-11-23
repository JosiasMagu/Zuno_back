import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, VerificationStatus } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { IDENTITY_DOCUMENT_LINK_MINUTES } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { SubmitVerificationDto } from '../dto/submit-verification.dto';
import {
  identityDocumentsFolder,
  isOwnIdentityDocument,
} from '../identity-documents';
import { VerificationPresenter } from '../presenters/verification.presenter';

const DOCUMENT_IDS = {
  documentFrontId: true,
  documentBackId: true,
  selfieId: true,
} as const;

type DocumentIds = Record<keyof typeof DOCUMENT_IDS, string | null>;

const idsOf = (documents: DocumentIds): string[] =>
  [
    documents.documentFrontId,
    documents.documentBackId,
    documents.selfieId,
  ].filter((id): id is string => id !== null);

@Injectable()
export class VerificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Guarda a foto de um documento no armazenamento privado. O identificador
   * que devolve é o que segue na submissão.
   */
  async uploadDocument(userId: string, file: Express.Multer.File) {
    await this.findSubmittable(userId);

    const { publicId } = await this.cloudinary.uploadPrivateImage(
      file,
      identityDocumentsFolder(userId),
    );

    return {
      message: 'Documento carregado com sucesso.',
      data: { documentId: publicId },
    };
  }

  /**
   * Submete (ou resubmete após REJECTED) os documentos KYC do utilizador.
   * Reset para PENDING limpa o motivo da rejeição anterior.
   */
  async submit(userId: string, dto: SubmitVerificationDto) {
    const existing = await this.findSubmittable(userId);
    const documents = this.ownDocuments(userId, dto);

    const v = existing
      ? // Resubmissão após rejeição: actualiza e volta a PENDING
        await this.prisma.userVerification.update({
          where: { userId },
          data: {
            status: VerificationStatus.PENDING,
            documentType: dto.documentType,
            ...documents,
            submittedAt: new Date(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null,
          },
        })
      : await this.prisma.userVerification.create({
          data: { userId, documentType: dto.documentType, ...documents },
        });

    await this.audit.record({
      action: AuditAction.USER_KYC_SUBMITTED,
      actorId: userId,
      targetType: 'UserVerification',
      targetId: v.id,
      metadata: {
        documentType: dto.documentType,
        isResubmission: !!existing,
      },
    });

    if (existing) {
      // Os documentos da submissão rejeitada deixaram de ter uso.
      const kept = idsOf(documents);
      await this.cloudinary.deletePrivateImages(
        idsOf(existing).filter((id) => !kept.includes(id)),
      );
    }

    return {
      message: 'Documentos submetidos. Aguarda revisão (até 48h).',
      data: VerificationPresenter.toOwnSummary(v),
    };
  }

  async getMyStatus(userId: string) {
    const v = await this.prisma.userVerification.findUnique({
      where: { userId },
    });

    if (!v) {
      return {
        message: 'Sem submissão de KYC ainda.',
        data: null,
      };
    }

    return {
      message: 'Estado de verificação obtido com sucesso.',
      data: VerificationPresenter.toOwnSummary(v),
    };
  }

  async findPending() {
    const items = await this.prisma.userVerification.findMany({
      where: { status: VerificationStatus.PENDING },
      orderBy: { submittedAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, phone: true, role: true } },
      },
    });

    return {
      message: 'Verificações pendentes obtidas com sucesso.',
      data: items.map((v) => VerificationPresenter.toAdminItem(v)),
    };
  }

  async approve(adminId: string, verificationId: string) {
    const v = await this.prisma.userVerification.findUnique({
      where: { id: verificationId },
      select: { id: true, userId: true, status: true },
    });

    if (!v) {
      throw new NotFoundException('Verificação não encontrada.');
    }
    if (v.status === VerificationStatus.VERIFIED) {
      throw new BadRequestException('Já aprovada anteriormente.');
    }

    const updated = await this.prisma.userVerification.update({
      where: { id: verificationId },
      data: {
        status: VerificationStatus.VERIFIED,
        reviewedAt: new Date(),
        reviewedBy: adminId,
        rejectionReason: null,
      },
      include: {
        user: { select: { id: true, name: true, phone: true, role: true } },
      },
    });

    await this.audit.record({
      action: AuditAction.USER_KYC_APPROVED,
      actorId: adminId,
      targetType: 'UserVerification',
      targetId: verificationId,
      metadata: {
        userId: v.userId,
        previousStatus: v.status,
      },
    });

    return {
      message: 'Verificação aprovada. Utilizador agora é VERIFIED.',
      data: VerificationPresenter.toAdminItem(updated),
    };
  }

  async reject(adminId: string, verificationId: string, reason: string) {
    const v = await this.prisma.userVerification.findUnique({
      where: { id: verificationId },
      select: { id: true, userId: true, status: true },
    });

    if (!v) {
      throw new NotFoundException('Verificação não encontrada.');
    }
    if (v.status === VerificationStatus.REJECTED) {
      throw new BadRequestException('Já rejeitada anteriormente.');
    }

    const updated = await this.prisma.userVerification.update({
      where: { id: verificationId },
      data: {
        status: VerificationStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedBy: adminId,
        rejectionReason: reason,
      },
      include: {
        user: { select: { id: true, name: true, phone: true, role: true } },
      },
    });

    await this.audit.record({
      action: AuditAction.USER_KYC_REJECTED,
      actorId: adminId,
      targetType: 'UserVerification',
      targetId: verificationId,
      metadata: {
        userId: v.userId,
        previousStatus: v.status,
        reason,
      },
    });

    return {
      message: 'Verificação rejeitada. Utilizador pode resubmeter.',
      data: VerificationPresenter.toAdminItem(updated),
    };
  }

  /**
   * Os documentos de uma verificação, para o admin decidir. São os dados
   * mais sensíveis que a plataforma guarda: os endereços valem poucos
   * minutos e cada consulta fica em auditoria, ou não se mostra nada.
   */
  async viewDocuments(adminId: string, verificationId: string) {
    const v = await this.prisma.userVerification.findUnique({
      where: { id: verificationId },
      select: { id: true, userId: true, ...DOCUMENT_IDS },
    });

    if (!v) {
      throw new NotFoundException('Verificação não encontrada.');
    }

    await this.prisma.$transaction((tx) =>
      this.audit.record(
        {
          action: AuditAction.USER_KYC_DOCUMENTS_VIEWED,
          actorId: adminId,
          targetType: 'UserVerification',
          targetId: v.id,
          metadata: { userId: v.userId },
        },
        tx,
      ),
    );

    const expiresAt = new Date(
      Date.now() + IDENTITY_DOCUMENT_LINK_MINUTES * 60_000,
    );
    const linkTo = (documentId: string | null) =>
      documentId
        ? this.cloudinary.privateImageUrl(documentId, expiresAt)
        : null;

    return {
      message: 'Documentos obtidos com sucesso.',
      data: {
        verificationId: v.id,
        documentFront: linkTo(v.documentFrontId),
        documentBack: linkTo(v.documentBackId),
        selfie: linkTo(v.selfieId),
        expiresAt,
      },
    };
  }

  /**
   * A verificação que a conta já tem, se ainda puder submeter. Quem está
   * verificado ou em revisão não submete nem carrega mais documentos.
   */
  private async findSubmittable(userId: string) {
    const existing = await this.prisma.userVerification.findUnique({
      where: { userId },
      select: { id: true, status: true, ...DOCUMENT_IDS },
    });

    if (existing?.status === VerificationStatus.VERIFIED) {
      throw new BadRequestException(
        'A tua conta já está verificada. Não é necessário resubmeter.',
      );
    }
    if (existing?.status === VerificationStatus.PENDING) {
      throw new BadRequestException(
        'Já tens uma submissão pendente em revisão.',
      );
    }

    return existing;
  }

  private ownDocuments(
    userId: string,
    dto: SubmitVerificationDto,
  ): DocumentIds {
    const documents = {
      documentFrontId: dto.documentFrontId,
      documentBackId: dto.documentBackId ?? null,
      selfieId: dto.selfieId,
    };
    const ids = idsOf(documents);

    if (ids.some((id) => !isOwnIdentityDocument(id, userId))) {
      throw new BadRequestException(
        'Carrega primeiro cada foto em /users/me/verification/documents e envia os identificadores que recebeste.',
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Cada foto tem de ser um carregamento diferente.',
      );
    }

    return documents;
  }

  /**
   * True quando o utilizador tem o KYC aprovado. É o que decide se os
   * anúncios dele (equipamentos e serviços) se publicam sem revisão.
   */
  async isVerified(userId: string): Promise<boolean> {
    const v = await this.prisma.userVerification.findUnique({
      where: { userId },
      select: { status: true },
    });
    return v?.status === VerificationStatus.VERIFIED;
  }
}
