import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import { PasswordConfirmationService } from '../../auth/services/password-confirmation.service';
import { SessionsService } from '../../auth/services/sessions.service';
import { ChangePayoutNumberDto } from '../dto/change-payout-number.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UserPresenter } from '../presenters/user.presenter';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly passwordConfirmation: PasswordConfirmationService,
    private readonly push: PushService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('Utilizador não encontrado.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Conta desativada.');
    }

    return {
      message: 'Perfil obtido com sucesso.',
      data: UserPresenter.toMe(user),
    };
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      throw new UnauthorizedException('Utilizador não encontrado.');
    }

    if (!existingUser.isActive) {
      throw new UnauthorizedException('Conta desativada.');
    }

    const data: {
      name?: string;
      email?: string | null;
      bio?: string | null;
      avatarUrl?: string | null;
    } = {};

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.bio !== undefined) {
      data.bio = dto.bio.trim() || null;
    }

    if (dto.avatarUrl !== undefined) {
      data.avatarUrl = dto.avatarUrl.trim() || null;
    }

    if (dto.email !== undefined) {
      const normalizedEmail = dto.email.trim().toLowerCase();

      if (!normalizedEmail) {
        data.email = null;
      } else {
        if (normalizedEmail !== (existingUser.email ?? '').toLowerCase()) {
          const emailOwner = await this.prisma.user.findUnique({
            where: { email: normalizedEmail },
          });

          if (emailOwner && emailOwner.id !== userId) {
            throw new BadRequestException('Este email já está em uso.');
          }
        }

        data.email = normalizedEmail;
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    // Quem tira a foto de perfil espera que ela deixe de existir.
    if (data.avatarUrl === null && existingUser.avatarUrl) {
      await this.cloudinary.deleteAvatar(userId);
    }

    return {
      message: 'Perfil atualizado com sucesso.',
      data: UserPresenter.toMe(updatedUser),
    };
  }

  async setAvatar(userId: string, file: Express.Multer.File) {
    const { url } = await this.cloudinary.uploadAvatar(file, userId);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: url },
    });

    return {
      message: 'Foto de perfil actualizada com sucesso.',
      data: UserPresenter.toMe(updatedUser),
    };
  }

  /**
   * Muda o número onde a conta recebe pagamentos e reembolsos. Pede a
   * password actual: sem ela, uma sessão roubada bastava para desviar o
   * dinheiro dos pagamentos seguintes.
   */
  async changePayoutNumber(
    userId: string,
    sessionId: string,
    dto: ChangePayoutNumberDto,
  ) {
    await this.passwordConfirmation.confirm(
      userId,
      dto.currentPassword,
      'PAYOUT_NUMBER_CHANGE',
    );

    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const message = 'Número de recebimento actualizado.';

    if (account.payoutMsisdn === dto.payoutMsisdn) {
      return { message, data: UserPresenter.toMe(account) };
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { payoutMsisdn: dto.payoutMsisdn },
    });

    await this.audit.record({
      action: AuditAction.USER_PAYOUT_NUMBER_CHANGED,
      actorId: userId,
      targetType: 'User',
      targetId: userId,
      metadata: {
        previous: account.payoutMsisdn,
        current: dto.payoutMsisdn,
        sessionId,
      },
    });

    this.warnOwnerOfNewPayoutNumber(account.pushToken, dto.payoutMsisdn);

    return { message, data: UserPresenter.toMe(updated) };
  }

  async getPublicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        bio: true,
        role: true,
        isActive: true,
        providerRating: true,
        providerReviews: true,
        clientRating: true,
        clientReviews: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    return {
      message: 'Perfil público obtido com sucesso.',
      data: UserPresenter.toPublicProfile(user),
    };
  }

  async savePushToken(userId: string, token: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { pushToken: token },
    });

    return {
      message: 'Token push guardado com sucesso.',
    };
  }

  /**
   * Avisa o dono da conta no telemóvel dele. Se a mudança não foi feita por
   * ele, fica a saber a tempo de trocar a password.
   */
  private warnOwnerOfNewPayoutNumber(
    pushToken: string | null,
    payoutMsisdn: string,
  ) {
    if (!pushToken) {
      return;
    }

    void this.push.send({
      to: pushToken,
      title: 'Número de recebimento alterado',
      body: `Os teus pagamentos passam a ir para o número terminado em ${payoutMsisdn.slice(-4)}. Se não foste tu, muda já a password.`,
      data: { type: 'payout_number_changed' },
    });
  }

  // Moderação (ADMIN)

  /**
   * Suspende um utilizador (isActive=false). O JwtAuthGuard / serviços
   * que verificam isActive vão recusar requests dele a partir de agora.
   * Auditado.
   */
  async suspend(adminId: string, targetUserId: string, reason?: string) {
    if (adminId === targetUserId) {
      throw new BadRequestException('Não podes suspender a tua própria conta.');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, isActive: true, role: true, name: true },
    });

    if (!target) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (!target.isActive) {
      throw new BadRequestException('Utilizador já está suspenso.');
    }

    if (target.role === 'ADMIN') {
      throw new BadRequestException(
        'Não é possível suspender contas de administrador por esta via.',
      );
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: false },
    });

    // Sem isto, reactivar a conta devolvia a vida às sessões antigas.
    await this.sessions.revokeAllForUser(targetUserId);

    await this.audit.record({
      action: AuditAction.USER_SUSPENDED,
      actorId: adminId,
      targetType: 'User',
      targetId: targetUserId,
      metadata: {
        targetName: target.name,
        targetRole: target.role,
        reason: reason ?? null,
      },
    });

    return { message: 'Utilizador suspenso com sucesso.' };
  }

  /**
   * Reactiva um utilizador previamente suspenso (isActive=true). Auditado.
   */
  async reactivate(adminId: string, targetUserId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, isActive: true, role: true, name: true },
    });

    if (!target) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (target.isActive) {
      throw new BadRequestException('Utilizador já está activo.');
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: true },
    });

    await this.audit.record({
      action: AuditAction.USER_REACTIVATED,
      actorId: adminId,
      targetType: 'User',
      targetId: targetUserId,
      metadata: {
        targetName: target.name,
        targetRole: target.role,
      },
    });

    return { message: 'Utilizador reactivado com sucesso.' };
  }
}
