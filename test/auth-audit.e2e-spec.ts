import { INestApplication } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { TEST_PASSWORD } from './helpers/seed-test-data';

const NEW_PASSWORD = 'mangueira-verde';
const USER_AGENT = 'ZunoApp/1.0 (e2e)';

describe('Account audit trail E2E', () => {
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

  function post(path: string, body: Record<string, unknown>) {
    return request(actors.httpServer)
      .post(`/api/v1/auth/${path}`)
      .set('User-Agent', USER_AGENT)
      .send(body);
  }

  const login = (password: string, phone = actors.seed.client.phone) =>
    post('login', { phone, password });

  const changePassword = (currentPassword: string) =>
    post('password/change', { currentPassword, newPassword: NEW_PASSWORD }).set(
      authHeader(actors.client.accessToken),
    );

  /** O que a auditoria tem sobre a conta do cliente, para uma acção. */
  const auditOf = (action: AuditAction) =>
    prisma().auditLog.findMany({
      where: { actorId: actors.client.userId, action },
      orderBy: { createdAt: 'asc' },
    });

  const sessionIdOf = (refreshToken: string) => refreshToken.split('.')[0];

  describe('login', () => {
    it('records the login against the session it opened, with its origin', async () => {
      const response = await login(TEST_PASSWORD).expect(201);

      const entry = await prisma().auditLog.findFirstOrThrow({
        where: {
          action: 'AUTH_LOGIN_SUCCEEDED',
          targetId: sessionIdOf(response.body.refreshToken as string),
        },
      });
      expect(entry).toMatchObject({
        actorId: actors.client.userId,
        targetType: 'AuthSession',
        metadata: { userAgent: USER_AGENT },
      });
      expect((entry.metadata as { ipAddress: string }).ipAddress).toContain(
        '127.0.0.1',
      );
    });

    it('records a wrong password on an account that exists', async () => {
      await login('password-errada').expect(401);

      const entries = await auditOf('AUTH_LOGIN_FAILED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetType: 'User',
        targetId: actors.client.userId,
        metadata: { reason: 'WRONG_PASSWORD', userAgent: USER_AGENT },
      });
    });

    it('records nothing for a number without an account', async () => {
      const countFailures = () =>
        prisma().auditLog.count({ where: { action: 'AUTH_LOGIN_FAILED' } });
      const before = await countFailures();

      await login('password-errada', '+258870000000').expect(401);

      expect(await countFailures()).toBe(before);
    });

    it('records the attempt to enter a suspended account', async () => {
      await prisma().user.update({
        where: { id: actors.client.userId },
        data: { isActive: false },
      });

      await login(TEST_PASSWORD).expect(403);

      const [entry] = await auditOf('AUTH_LOGIN_FAILED');
      expect(entry.metadata).toMatchObject({ reason: 'ACCOUNT_SUSPENDED' });
    });

    it('stops recording once the number is locked', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login('password-errada').expect(401);
      }

      await login('password-errada').expect(429);

      expect(await auditOf('AUTH_LOGIN_FAILED')).toHaveLength(5);
    });
  });

  describe('password change', () => {
    it('records the change and the session that asked for it', async () => {
      await changePassword(TEST_PASSWORD).expect(201);

      const [entry] = await auditOf('AUTH_PASSWORD_CHANGED');
      expect(entry).toMatchObject({
        targetType: 'User',
        targetId: actors.client.userId,
        metadata: { sessionId: sessionIdOf(actors.client.refreshToken) },
      });
    });

    it('answers 400 to a wrong current password and keeps the session', async () => {
      const response = await changePassword('password-errada');

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('AUTH_WRONG_CURRENT_PASSWORD');
      await request(actors.httpServer)
        .get('/api/v1/auth/me')
        .set(authHeader(actors.client.accessToken))
        .expect(200);
      await login(TEST_PASSWORD).expect(201);
    });

    it('records the refused attempt and no change', async () => {
      await changePassword('password-errada').expect(400);

      const [entry] = await auditOf('AUTH_PASSWORD_CONFIRMATION_FAILED');
      expect(entry.metadata).toEqual({ operation: 'PASSWORD_CHANGE' });
      expect(await auditOf('AUTH_PASSWORD_CHANGED')).toHaveLength(0);
    });
  });

  describe('password reset', () => {
    async function storeResetCode(code: string) {
      await prisma().verificationCode.create({
        data: {
          userId: actors.client.userId,
          purpose: 'PASSWORD_RESET',
          codeHash: await bcrypt.hash(code, 4),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }

    const resetPassword = (code: string) =>
      post('password/reset', {
        phone: actors.seed.client.phone,
        code,
        newPassword: NEW_PASSWORD,
      });

    it('records the reset with the origin of the request', async () => {
      await storeResetCode('123456');

      await resetPassword('123456').expect(201);

      const [entry] = await auditOf('AUTH_PASSWORD_RESET');
      expect(entry).toMatchObject({
        targetType: 'User',
        targetId: actors.client.userId,
        metadata: { userAgent: USER_AGENT },
      });
    });

    it('records nothing when the code is wrong', async () => {
      await storeResetCode('123456');

      await resetPassword('654321').expect(400);

      expect(await auditOf('AUTH_PASSWORD_RESET')).toHaveLength(0);
    });
  });
});
