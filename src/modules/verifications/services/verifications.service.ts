import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, VerificationStatus } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { SubmitVerificationDto } from '../dto/submit-verification.dto';
import { VerificationPresenter } from '../presenters/verification.presenter';

@Injectable()
export class VerificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Submete (ou resubmete após REJECTED) os documentos KYC do utilizador.
   * Reset para PENDING limpa o motivo da rejeição anterior.
   */
  async submit(userId: string, dto: SubmitVerificationDto) {
    const existing = await this.prisma.userVerification.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });

    if (existing && existing.status === VerificationStatus.VERIFIED) {
      throw new BadRequestException(
        'A tua conta já está verificada. Não é necessário resubmeter.',
      );
    }
    if (existing && existing.status === VerificationStatus.PENDING) {
      throw new BadRequestException(
        'Já tens uma submissão pendente em revisão.',
      );
    }

    const v = existing
      ? // Resubmissão após rejeição: actualiza e volta a PENDING
        await this.prisma.userVerification.update({
          where: { userId },
          data: {
            status: VerificationStatus.PENDING,
            documentType: dto.documentType,
            documentFrontUrl: dto.documentFrontUrl,
            documentBackUrl: dto.documentBackUrl ?? null,
            selfieUrl: dto.selfieUrl,
            submittedAt: new Date(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null,
          },
        })
      : await this.prisma.userVerification.create({
          data: {
            userId,
            documentType: dto.documentType,
            documentFrontUrl: dto.documentFrontUrl,
            documentBackUrl: dto.documentBackUrl ?? null,
            selfieUrl: dto.selfieUrl,
          },
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
   * Helper interno usado pelo EquipmentService para decidir auto-approve.
   * Devolve true sse o utilizador tem KYC aprovado.
   */
  async isVerified(userId: string): Promise<boolean> {
    const v = await this.prisma.userVerification.findUnique({
      where: { userId },
      select: { status: true },
    });
    return v?.status === VerificationStatus.VERIFIED;
  }
}
