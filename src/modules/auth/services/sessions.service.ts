import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuthSession } from '@prisma/client';
import ms, { StringValue } from 'ms';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { LiveConnections } from '../../../shared/realtime/live-connections';

const REFRESH_SECRET_BYTES = 32;
const DEFAULT_SESSION_LIFETIME: StringValue = '7d';
const DEFAULT_REUSE_GRACE_SECONDS = 30;
const STALE_SESSION_RETENTION_DAYS = 30;
const MAX_USER_AGENT_LENGTH = 255;

const SESSION_USER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  isVerified: true,
  isActive: true,
  avatarUrl: true,
  bio: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** De onde veio o pedido que abriu a sessão. */
export interface SessionOrigin {
  ipAddress?: string;
  userAgent?: string;
}

/** Uma sessão acabada de abrir ou de renovar, com o refresh token em claro. */
export interface IssuedSession {
  sessionId: string;
  userId: string;
  refreshToken: string;
}

/**
 * Sessões de autenticação e os seus refresh tokens.
 *
 * O refresh token é opaco, no formato `<id da sessão>.<segredo>`, e a base só
 * guarda o SHA-256 do segredo. Cada renovação troca o segredo. Um token que
 * não seja o actual é sinal de que alguém o copiou, e a sessão é revogada. A
 * única excepção é o token imediatamente anterior, durante os segundos de
 * tolerância: cobre a aplicação que renovou, perdeu a resposta na rede e
 * volta a tentar com o token antigo.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly lifetimeMs: number;
  private readonly reuseGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
    private readonly live: LiveConnections,
  ) {
    this.lifetimeMs = ms(
      config.get<StringValue>('JWT_REFRESH_EXPIRES_IN') ??
        DEFAULT_SESSION_LIFETIME,
    );
    if (!(this.lifetimeMs > 0)) {
      throw new Error(
        'JWT_REFRESH_EXPIRES_IN tem de ser uma duração válida, como "7d".',
      );
    }

    this.reuseGraceMs =
      Number(
        config.get('REFRESH_TOKEN_REUSE_GRACE_SECONDS') ??
          DEFAULT_REUSE_GRACE_SECONDS,
      ) * 1000;
  }

  /** Abre uma sessão para quem acabou de se autenticar. */
  async open(
    userId: string,
    origin: SessionOrigin = {},
  ): Promise<IssuedSession> {
    await this.deleteStaleSessions(userId);

    const secret = this.generateSecret();
    const session = await this.prisma.authSession.create({
      data: {
        userId,
        refreshTokenHash: this.hash(secret),
        expiresAt: this.expiryFromNow(),
        ipAddress: origin.ipAddress ?? null,
        userAgent: origin.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      },
    });

    return this.issue(session, secret);
  }

  /**
   * Troca um refresh token válido por outro e prolonga a sessão. O token
   * apresentado deixa de servir, salvo durante os segundos de tolerância.
   */
  async rotate(refreshToken: string, isRetry = false): Promise<IssuedSession> {
    const presented = this.parse(refreshToken);

    const session = await this.prisma.authSession.findUnique({
      where: { id: presented.sessionId },
      include: { user: { select: { isActive: true } } },
    });

    if (!session || session.revokedAt) {
      throw new UnauthorizedException('Sessão inválida ou revogada.');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.revoke(session.id);
      throw new UnauthorizedException('Refresh token expirado.');
    }

    if (!session.user.isActive) {
      await this.revoke(session.id);
      throw new UnauthorizedException('Conta desativada.');
    }

    if (!this.mayRotate(session, presented.secret)) {
      await this.revokeAsCompromised(session);
      throw new UnauthorizedException('Sessão inválida ou revogada.');
    }

    const secret = this.generateSecret();
    const rotated = await this.prisma.authSession.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        refreshTokenHash: session.refreshTokenHash,
      },
      data: {
        refreshTokenHash: this.hash(secret),
        previousTokenHash: session.refreshTokenHash,
        rotatedAt: new Date(),
        expiresAt: this.expiryFromNow(),
      },
    });

    if (rotated.count === 1) {
      return this.issue(session, secret);
    }

    // Outro pedido renovou a sessão entre a leitura e a escrita. Volta-se a
    // avaliar o token uma vez, já contra o estado novo.
    if (isRetry) {
      throw new UnauthorizedException('Sessão inválida ou revogada.');
    }
    return this.rotate(refreshToken, true);
  }

  /** Termina a sessão a que o refresh token pertence (logout). */
  async revokeByToken(refreshToken: string): Promise<void> {
    const presented = this.parse(refreshToken);

    const session = await this.prisma.authSession.findUnique({
      where: { id: presented.sessionId },
    });

    const ownsSession =
      session &&
      !session.revokedAt &&
      (this.matches(presented.secret, session.refreshTokenHash) ||
        this.matches(presented.secret, session.previousTokenHash));

    if (!ownsSession) {
      throw new UnauthorizedException('Sessão inválida ou já revogada.');
    }

    await this.revoke(session.id);
  }

  /**
   * Termina as sessões activas de um utilizador. Com `exceptSessionId` fica
   * de fora a sessão de quem fez o pedido. Devolve quantas terminou.
   */
  async revokeAllForUser(
    userId: string,
    { exceptSessionId }: { exceptSessionId?: string } = {},
  ): Promise<number> {
    const revoked = await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });

    // Um socket aberto nestas sessões fecha já, e não quando cair sozinho.
    this.live.closeUser(userId, exceptSessionId);

    return revoked.count;
  }

  /**
   * A sessão de um access token, com o utilizador. Devolve null se a sessão
   * não existir, tiver sido revogada ou já tiver expirado.
   */
  async findUsable(sessionId: string) {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: SESSION_USER_SELECT },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }

    return session;
  }

  /** O token apresentado é o actual, ou o anterior ainda dentro da tolerância. */
  private mayRotate(session: AuthSession, secret: string): boolean {
    if (this.matches(secret, session.refreshTokenHash)) {
      return true;
    }

    const rotatedRecently =
      session.rotatedAt !== null &&
      Date.now() - session.rotatedAt.getTime() <= this.reuseGraceMs;

    return rotatedRecently && this.matches(secret, session.previousTokenHash);
  }

  private async revokeAsCompromised(session: AuthSession): Promise<void> {
    await this.revoke(session.id);

    this.logger.warn(
      { sessionId: session.id, userId: session.userId },
      'Refresh token reutilizado: sessão revogada.',
    );

    await this.audit.record({
      action: AuditAction.AUTH_REFRESH_TOKEN_REUSED,
      actorId: session.userId,
      targetType: 'AuthSession',
      targetId: session.id,
    });
  }

  private async revoke(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.live.closeSession(sessionId);
  }

  /** Apaga as sessões do utilizador que acabaram há mais tempo do que a retenção. */
  private async deleteStaleSessions(userId: string): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_SESSION_RETENTION_DAYS);

    await this.prisma.authSession.deleteMany({
      where: {
        userId,
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
  }

  private parse(refreshToken: string): { sessionId: string; secret: string } {
    const token = refreshToken?.trim();
    if (!token) {
      throw new UnauthorizedException('Refresh token é obrigatório.');
    }

    const separator = token.indexOf('.');
    const sessionId = token.slice(0, separator);
    const secret = token.slice(separator + 1);

    if (separator <= 0 || !secret) {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }

    return { sessionId, secret };
  }

  private issue(
    session: { id: string; userId: string },
    secret: string,
  ): IssuedSession {
    return {
      sessionId: session.id,
      userId: session.userId,
      refreshToken: `${session.id}.${secret}`,
    };
  }

  private generateSecret(): string {
    return randomBytes(REFRESH_SECRET_BYTES).toString('base64url');
  }

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /** Compara em tempo constante o segredo apresentado com um hash guardado. */
  private matches(secret: string, storedHash: string | null): boolean {
    if (!storedHash) {
      return false;
    }

    const presented = Buffer.from(this.hash(secret), 'hex');
    const stored = Buffer.from(storedHash, 'hex');

    return (
      presented.length === stored.length && timingSafeEqual(presented, stored)
    );
  }

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.lifetimeMs);
  }
}
