import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthSession, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { StringValue } from 'ms';

import { PrismaService } from '../../../shared/db/prisma.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const phone = dto.phone.trim();
    const email = dto.email?.trim().toLowerCase();
    const name = dto.name.trim();

    const existingByPhone = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingByPhone) {
      throw new BadRequestException('Este número de telefone já está em uso.');
    }

    if (email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingByEmail) {
        throw new BadRequestException('Este email já está em uso.');
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const createdUser = await this.prisma.user.create({
      data: {
        name,
        phone,
        email,
        passwordHash,
      },
    });

    const tokens = await this.generateTokens(
      createdUser.id,
      createdUser.phone,
      createdUser.role,
    );

    await this.createSession(createdUser.id, tokens.refreshToken);

    return {
      message: 'Conta criada com sucesso.',
      user: this.toSafeUser(createdUser),
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const phone = dto.phone.trim();

    const user = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Conta desativada.');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    const tokens = await this.generateTokens(user.id, user.phone, user.role);
    await this.createSession(user.id, tokens.refreshToken);

    return {
      message: 'Login realizado com sucesso.',
      user: this.toSafeUser(user),
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    if (!refreshToken?.trim()) {
      throw new UnauthorizedException('Refresh token é obrigatório.');
    }

    const payload = await this.verifyRefreshToken(refreshToken);

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('Utilizador não encontrado.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Conta desativada.');
    }

    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const matchedSession = await this.findMatchingSession(
      sessions,
      refreshToken,
    );

    if (!matchedSession) {
      throw new UnauthorizedException('Sessão inválida ou revogada.');
    }

    if (matchedSession.expiresAt.getTime() < Date.now()) {
      await this.prisma.authSession.update({
        where: { id: matchedSession.id },
        data: {
          revokedAt: new Date(),
        },
      });

      throw new UnauthorizedException('Refresh token expirado.');
    }

    const tokens = await this.generateTokens(user.id, user.phone, user.role);

    const newRefreshTokenHash = await bcrypt.hash(tokens.refreshToken, 10);

    await this.prisma.authSession.update({
      where: { id: matchedSession.id },
      data: {
        refreshTokenHash: newRefreshTokenHash,
        expiresAt: this.getRefreshTokenExpiryDate(),
        revokedAt: null,
      },
    });

    return {
      message: 'Token renovado com sucesso.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(refreshToken: string) {
    if (!refreshToken?.trim()) {
      throw new UnauthorizedException('Refresh token é obrigatório.');
    }

    const payload = await this.verifyRefreshToken(refreshToken);

    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId: payload.sub,
        revokedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const matchedSession = await this.findMatchingSession(
      sessions,
      refreshToken,
    );

    if (!matchedSession) {
      throw new UnauthorizedException('Sessão inválida ou já revogada.');
    }

    await this.prisma.authSession.update({
      where: { id: matchedSession.id },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: 'Logout realizado com sucesso.',
    };
  }

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

    return this.toSafeUser(user);
  }

  private async generateTokens(userId: string, phone: string, role: UserRole) {
    // getOrThrow lança InternalServerErrorException se a variável não existir.
    // Nunca usar fallback com string hardcoded — seria uma vulnerabilidade crítica.
    const accessSecret =
      this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');

    const refreshSecret =
      this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');

    const accessExpiresIn = (this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
    ) ?? '15m') as StringValue;

    const refreshExpiresIn = (this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
    ) ?? '7d') as StringValue;

    const payload = {
      sub: userId,
      phone,
      role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: accessSecret,
      expiresIn: accessExpiresIn,
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: refreshSecret,
      expiresIn: refreshExpiresIn,
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  private async createSession(userId: string, refreshToken: string) {
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

    await this.prisma.authSession.create({
      data: {
        userId,
        refreshTokenHash,
        expiresAt: this.getRefreshTokenExpiryDate(),
      },
    });
  }

  private getRefreshTokenExpiryDate() {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    return expiresAt;
  }

  private async verifyRefreshToken(refreshToken: string) {
    const refreshSecret =
      this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');

    try {
      return await this.jwtService.verifyAsync<{
        sub: string;
        phone: string;
        role: UserRole;
      }>(refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }
  }

  private async findMatchingSession(
    sessions: AuthSession[],
    refreshToken: string,
  ) {
    for (const session of sessions) {
      const isMatch = await bcrypt.compare(
        refreshToken,
        session.refreshTokenHash,
      );

      if (isMatch) {
        return session;
      }
    }

    return null;
  }

  private toSafeUser(user: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    role: UserRole;
    isVerified: boolean;
    isActive: boolean;
    avatarUrl: string | null;
    bio: string | null;
    createdAt: Date;
    updatedAt?: Date;
  }) {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
