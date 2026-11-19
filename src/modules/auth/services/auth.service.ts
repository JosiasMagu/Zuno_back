import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole, VerificationPurpose } from '@prisma/client';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import { normalizeMzPhone } from '../../../shared/phone/mz-phone';
import { ACCESS_TOKEN_TYPE, AccessTokenPayload } from '../access-token';
import {
  ChangePasswordDto,
  ConfirmPhoneVerificationDto,
  ForgotPasswordDto,
  RequestPhoneVerificationDto,
  ResetPasswordDto,
} from '../dto/verification.dto';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { AuthAuditService } from './auth-audit.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordConfirmationService } from './password-confirmation.service';
import { PasswordHasher } from './password-hasher.service';
import { SessionOrigin, SessionsService } from './sessions.service';
import { invalidCodeError, VerificationService } from './verification.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly sessions: SessionsService,
    private readonly passwords: PasswordHasher,
    private readonly loginThrottle: LoginThrottleService,
    private readonly verification: VerificationService,
    private readonly passwordConfirmation: PasswordConfirmationService,
    private readonly audit: AuthAuditService,
  ) {}

  async requestPhoneVerification(dto: RequestPhoneVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true, phone: true, email: true, isVerified: true },
    });

    if (user && !user.isVerified) {
      await this.verification.issueCode({
        userId: user.id,
        phone: user.phone,
        email: user.email,
        purpose: VerificationPurpose.PHONE_VERIFICATION,
      });
    }

    return { message: 'Se a conta existir, foi enviado um código.' };
  }

  async confirmPhoneVerification(dto: ConfirmPhoneVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true, isVerified: true },
    });

    if (!user) {
      throw invalidCodeError();
    }

    if (user.isVerified) {
      return { message: 'Conta já verificada.' };
    }

    await this.verification.consumeCode({
      userId: user.id,
      code: dto.code,
      purpose: VerificationPurpose.PHONE_VERIFICATION,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    });

    return { message: 'Conta verificada com sucesso.' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true, phone: true, email: true, isActive: true },
    });

    if (user?.isActive) {
      await this.verification.issueCode({
        userId: user.id,
        phone: user.phone,
        email: user.email,
        purpose: VerificationPurpose.PASSWORD_RESET,
      });
    }

    return {
      message:
        'Se a conta existir, foi enviado um código para redefinir a password.',
    };
  }

  async resetPassword(dto: ResetPasswordDto, origin: SessionOrigin = {}) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw invalidCodeError();
    }

    // Antes de gastar o código: uma password recusada não o deve queimar.
    this.assertNotPhoneNumber(dto.newPassword, dto.phone);

    await this.verification.consumeCode({
      userId: user.id,
      code: dto.code,
      purpose: VerificationPurpose.PASSWORD_RESET,
    });

    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit.passwordReset(user.id, origin);

    return {
      message:
        'Password redefinida com sucesso. As sessões activas foram revogadas.',
    };
  }

  /**
   * Troca a password de quem está autenticado. As outras sessões da conta
   * terminam; a sessão de onde veio o pedido continua.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    dto: ChangePasswordDto,
  ) {
    const { phone } = await this.passwordConfirmation.confirm(
      userId,
      dto.currentPassword,
      'PASSWORD_CHANGE',
    );

    this.assertNotPhoneNumber(dto.newPassword, phone);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(dto.newPassword) },
    });

    await this.sessions.revokeAllForUser(userId, {
      exceptSessionId: sessionId,
    });

    await this.audit.passwordChanged(userId, sessionId);

    return { message: 'Password alterada com sucesso.' };
  }

  async register(dto: RegisterDto, origin: SessionOrigin = {}) {
    const { phone } = dto;
    const email = dto.email?.trim().toLowerCase();
    const name = dto.name.trim();

    this.assertNotPhoneNumber(dto.password, phone);

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

    const createdUser = await this.prisma.user.create({
      data: {
        name,
        phone,
        email,
        passwordHash: await this.passwords.hash(dto.password),
      },
    });

    const { tokens } = await this.startSession(createdUser.id, origin);

    return {
      message: 'Conta criada com sucesso.',
      user: this.toSafeUser(createdUser),
      ...tokens,
    };
  }

  async login(dto: LoginDto, origin: SessionOrigin = {}) {
    const { phone } = dto;

    await this.loginThrottle.assertNotLocked(phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
    });

    // A password é comparada exista ou não a conta, e a resposta é a mesma
    // nos dois casos: quem tenta não fica a saber que números têm conta.
    const passwordMatches = await this.passwords.matches(
      dto.password,
      user?.passwordHash,
    );

    if (!user || !passwordMatches) {
      await this.loginThrottle.recordFailure(phone);

      if (user) {
        await this.audit.loginFailed(user.id, 'WRONG_PASSWORD', origin);
      }

      throw ApiErrors.unauthorized(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Credenciais inválidas.',
      );
    }

    // Só quem acertou na password fica a saber que a conta está desactivada.
    if (!user.isActive) {
      await this.audit.loginFailed(user.id, 'ACCOUNT_SUSPENDED', origin);
      throw ApiErrors.forbidden(ErrorCode.FORBIDDEN, 'Conta desativada.');
    }

    await this.loginThrottle.clear(phone);
    await this.upgradePasswordHash(user.id, dto.password, user.passwordHash);

    const { sessionId, tokens } = await this.startSession(user.id, origin);
    await this.audit.loginSucceeded(user.id, sessionId, origin);

    return {
      message: 'Login realizado com sucesso.',
      user: this.toSafeUser(user),
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    const session = await this.sessions.rotate(refreshToken);

    return {
      message: 'Token renovado com sucesso.',
      accessToken: await this.signAccessToken(
        session.userId,
        session.sessionId,
      ),
      refreshToken: session.refreshToken,
    };
  }

  async logout(refreshToken: string) {
    await this.sessions.revokeByToken(refreshToken);

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

  /** Usar o próprio telefone como password é das primeiras coisas que se tentam. */
  private assertNotPhoneNumber(password: string, phone: string) {
    if (normalizeMzPhone(password) === phone) {
      throw new BadRequestException(
        'A password não pode ser o teu número de telefone.',
      );
    }
  }

  /**
   * Refaz o hash de uma password guardada com um custo de bcrypt mais baixo
   * do que o actual. Só se pode fazer no login, que é quando se tem a
   * password em claro.
   */
  private async upgradePasswordHash(
    userId: string,
    password: string,
    storedHash: string,
  ) {
    if (!this.passwords.needsRehash(storedHash)) {
      return;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(password) },
    });
  }

  /** Abre a sessão de quem acabou de se autenticar. Devolve o id dela e o par de tokens. */
  private async startSession(userId: string, origin: SessionOrigin) {
    const session = await this.sessions.open(userId, origin);

    return {
      sessionId: session.sessionId,
      tokens: {
        accessToken: await this.signAccessToken(userId, session.sessionId),
        refreshToken: session.refreshToken,
      },
    };
  }

  /**
   * O access token leva o id da sessão, para deixar de ser aceite assim que
   * a sessão for revogada. O segredo e a validade vêm do JwtModule.
   */
  private signAccessToken(userId: string, sessionId: string) {
    const payload: AccessTokenPayload = {
      sub: userId,
      sid: sessionId,
      typ: ACCESS_TOKEN_TYPE,
    };

    return this.jwtService.signAsync(payload);
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
    payoutMsisdn?: string | null;
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
      payoutMsisdn: user.payoutMsisdn ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
