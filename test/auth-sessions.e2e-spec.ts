import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginViaApi, LoginResult } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { TEST_PASSWORD } from './helpers/seed-test-data';

const NEW_PASSWORD = 'NovaPass@2026!';

describe('Auth sessions E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  function refresh(refreshToken: string) {
    return request(actors.httpServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
  }

  function logout(refreshToken: string) {
    return request(actors.httpServer)
      .post('/api/v1/auth/logout')
      .send({ refreshToken });
  }

  function me(accessToken: string) {
    return request(actors.httpServer)
      .get('/api/v1/auth/me')
      .set(authHeader(accessToken));
  }

  /** Um segundo login da mesma conta, como se fosse outro aparelho. */
  function loginOnAnotherDevice(): Promise<LoginResult> {
    return loginViaApi(app, actors.seed.client.phone, TEST_PASSWORD);
  }

  function sessionIdOf(refreshToken: string): string {
    return refreshToken.split('.')[0];
  }

  function readSession(refreshToken: string) {
    return prisma().authSession.findUniqueOrThrow({
      where: { id: sessionIdOf(refreshToken) },
    });
  }

  /** Faz de conta que a última renovação da sessão foi há um minuto. */
  async function letReuseGraceExpire(refreshToken: string) {
    await prisma().authSession.update({
      where: { id: sessionIdOf(refreshToken) },
      data: { rotatedAt: new Date(Date.now() - 60_000) },
    });
  }

  describe('login', () => {
    it('opens a session and keeps only the hash of the refresh token', async () => {
      const { refreshToken } = actors.client;
      const [, secret] = refreshToken.split('.');

      const session = await readSession(refreshToken);

      expect(session.userId).toBe(actors.client.userId);
      expect(session.revokedAt).toBeNull();
      expect(session.refreshTokenHash).toBe(
        createHash('sha256').update(secret).digest('hex'),
      );
      expect(session.previousTokenHash).toBeNull();
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('gives each login its own session', async () => {
      const other = await loginOnAnotherDevice();

      expect(sessionIdOf(other.refreshToken)).not.toBe(
        sessionIdOf(actors.client.refreshToken),
      );
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and extends the session', async () => {
      const { refreshToken } = actors.client;
      const before = await readSession(refreshToken);

      const response = await refresh(refreshToken);

      expect(response.status).toBe(201);
      expect(response.body.refreshToken).not.toBe(refreshToken);
      expect(sessionIdOf(response.body.refreshToken as string)).toBe(
        sessionIdOf(refreshToken),
      );
      await me(response.body.accessToken as string).expect(200);

      const after = await readSession(refreshToken);
      expect(after.refreshTokenHash).not.toBe(before.refreshTokenHash);
      expect(after.previousTokenHash).toBe(before.refreshTokenHash);
      expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before.expiresAt.getTime(),
      );
    });

    it('accepts the previous token again right after a rotation', async () => {
      const { refreshToken } = actors.client;
      await refresh(refreshToken).expect(201);

      const retry = await refresh(refreshToken);

      expect(retry.status).toBe(201);
      expect((await readSession(refreshToken)).revokedAt).toBeNull();
      await refresh(retry.body.refreshToken as string).expect(201);
    });

    it('revokes the session when a rotated token comes back later', async () => {
      const { refreshToken } = actors.client;
      const rotated = await refresh(refreshToken).expect(201);
      await letReuseGraceExpire(refreshToken);

      const reuse = await refresh(refreshToken);

      expect(reuse.status).toBe(401);
      expect((await readSession(refreshToken)).revokedAt).not.toBeNull();
      await refresh(rotated.body.refreshToken as string).expect(401);
      await me(rotated.body.accessToken as string).expect(401);

      const audits = await prisma().auditLog.findMany({
        where: {
          action: 'AUTH_REFRESH_TOKEN_REUSED',
          targetId: sessionIdOf(refreshToken),
        },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: actors.client.userId,
        targetType: 'AuthSession',
      });
    });

    it('revokes the session when the secret does not belong to it', async () => {
      const { refreshToken } = actors.client;
      const forged = `${sessionIdOf(refreshToken)}.not-the-secret`;

      const response = await refresh(forged);

      expect(response.status).toBe(401);
      expect((await readSession(refreshToken)).revokedAt).not.toBeNull();
      await refresh(refreshToken).expect(401);
    });

    it.each(['no-separator', 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', '.secret'])(
      'returns 401 for the token %p',
      async (token) => {
        const response = await refresh(token);

        expect(response.status).toBe(401);
      },
    );

    it('returns 401 for an expired session and revokes it', async () => {
      const { refreshToken } = actors.client;
      await prisma().authSession.update({
        where: { id: sessionIdOf(refreshToken) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await refresh(refreshToken);

      expect(response.status).toBe(401);
      expect((await readSession(refreshToken)).revokedAt).not.toBeNull();
    });
  });

  describe('access token', () => {
    it('is refused when it does not name a session', async () => {
      const withoutSession = app
        .get(JwtService)
        .sign({ sub: actors.client.userId, typ: 'access' });

      await me(withoutSession).expect(401);
    });

    it('is refused when it names the session of another user', async () => {
      const stolenSession = app.get(JwtService).sign({
        sub: actors.admin.userId,
        sid: sessionIdOf(actors.client.refreshToken),
        typ: 'access',
      });

      await me(stolenSession).expect(401);
    });
  });

  describe('logout', () => {
    it('ends the session for the refresh token and for the access token', async () => {
      const { accessToken, refreshToken } = actors.client;
      await me(accessToken).expect(200);

      const response = await logout(refreshToken);

      expect(response.status).toBe(201);
      await refresh(refreshToken).expect(401);
      await me(accessToken).expect(401);
    });

    it('leaves the other devices of the account signed in', async () => {
      const other = await loginOnAnotherDevice();

      await logout(actors.client.refreshToken).expect(201);

      await me(other.accessToken).expect(200);
      await refresh(other.refreshToken).expect(201);
    });

    it('returns 401 when the session was already ended', async () => {
      await logout(actors.client.refreshToken).expect(201);

      const response = await logout(actors.client.refreshToken);

      expect(response.status).toBe(401);
    });

    it('returns 401 and keeps the session when the secret is wrong', async () => {
      const { refreshToken } = actors.client;

      const response = await logout(
        `${sessionIdOf(refreshToken)}.not-the-secret`,
      );

      expect(response.status).toBe(401);
      expect((await readSession(refreshToken)).revokedAt).toBeNull();
    });
  });

  describe('password change', () => {
    it('ends the other sessions and keeps the one that asked', async () => {
      const other = await loginOnAnotherDevice();

      await request(actors.httpServer)
        .post('/api/v1/auth/password/change')
        .set(authHeader(actors.client.accessToken))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(201);

      await me(actors.client.accessToken).expect(200);
      await me(other.accessToken).expect(401);
      await refresh(other.refreshToken).expect(401);
      await loginViaApi(app, actors.seed.client.phone, NEW_PASSWORD);
    });
  });

  describe('password reset', () => {
    it('ends every session of the account', async () => {
      const other = await loginOnAnotherDevice();
      await prisma().verificationCode.create({
        data: {
          userId: actors.client.userId,
          purpose: 'PASSWORD_RESET',
          codeHash: await bcrypt.hash('123456', 4),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await request(actors.httpServer)
        .post('/api/v1/auth/password/reset')
        .send({
          phone: actors.seed.client.phone,
          code: '123456',
          newPassword: NEW_PASSWORD,
        })
        .expect(201);

      await me(actors.client.accessToken).expect(401);
      await me(other.accessToken).expect(401);
      await refresh(actors.client.refreshToken).expect(401);
      await loginViaApi(app, actors.seed.client.phone, NEW_PASSWORD);
    });
  });

  describe('account suspension', () => {
    function moderate(action: 'suspend' | 'reactivate') {
      return request(actors.httpServer)
        .patch(`/api/v1/users/${actors.client.userId}/${action}`)
        .set(authHeader(actors.admin.accessToken))
        .send({});
    }

    it('ends every session, and reactivation does not bring them back', async () => {
      await moderate('suspend').expect(200);

      await me(actors.client.accessToken).expect(401);
      await refresh(actors.client.refreshToken).expect(401);

      await moderate('reactivate').expect(200);

      await me(actors.client.accessToken).expect(401);
      await refresh(actors.client.refreshToken).expect(401);
      await loginViaApi(app, actors.seed.client.phone, TEST_PASSWORD);
    });
  });
});
