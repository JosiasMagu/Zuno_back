import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../../../shared/db/prisma.service';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UserPresenter } from '../presenters/user.presenter';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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

    return {
      message: 'Perfil atualizado com sucesso.',
      data: UserPresenter.toMe(updatedUser),
    };
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
        totalRating: true,
        totalReviews: true,
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
}
