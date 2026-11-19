import { INestApplication } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import request from 'supertest';

import { PushService } from '../src/shared/push/push.service';
import type { PushPayload } from '../src/shared/push/push.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { TEST_PASSWORD } from './helpers/seed-test-data';

const PAYOUT_NUMBER = '+258841234567';
const PREVIOUS_PAYOUT_NUMBER = '+258850000009';
const PUSH_TOKEN = 'ExponentPushToken[e2e]';

describe('Payout number E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let pushed: PushPayload[];
  const prisma = () => getTestPrisma();

  // Faz de serviço de push: guarda o que a aplicação mandou enviar.
  const push = {
    send: (payload: PushPayload) => {
      pushed.push(payload);
      return Promise.resolve();
    },
    sendToMany: () => Promise.resolve(),
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(PushService).useValue(push),
    );
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
    pushed = [];
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  function changePayoutNumber(body: Record<string, unknown>) {
    return request(actors.httpServer)
      .put('/api/v1/users/me/payout-number')
      .set(authHeader(actors.provider.accessToken))
      .send(body);
  }

  const withRightPassword = (payoutMsisdn = PAYOUT_NUMBER) =>
    changePayoutNumber({ payoutMsisdn, currentPassword: TEST_PASSWORD });

  const withWrongPassword = () =>
    changePayoutNumber({
      payoutMsisdn: PAYOUT_NUMBER,
      currentPassword: 'password-errada',
    });

  const readProvider = () =>
    prisma().user.findUniqueOrThrow({ where: { id: actors.provider.userId } });

  const updateProvider = (data: {
    payoutMsisdn?: string;
    pushToken?: string;
  }) => prisma().user.update({ where: { id: actors.provider.userId }, data });

  const auditOf = (action: AuditAction) =>
    prisma().auditLog.findMany({
      where: { actorId: actors.provider.userId, action },
    });

  describe('with the current password', () => {
    it('stores the number in E.164 whatever way it was typed', async () => {
      const response = await withRightPassword('84 123 4567');

      expect(response.status).toBe(200);
      expect(response.body.data.payoutMsisdn).toBe(PAYOUT_NUMBER);
      const profile = await request(actors.httpServer)
        .get('/api/v1/users/me')
        .set(authHeader(actors.provider.accessToken))
        .expect(200);
      expect(profile.body.data.payoutMsisdn).toBe(PAYOUT_NUMBER);
    });

    it.each(['21123456', '811234567', '+27841234567', ''])(
      'returns 400 for the number %p',
      async (payoutMsisdn) => {
        const response = await withRightPassword(payoutMsisdn);

        expect(response.status).toBe(400);
        expect((await readProvider()).payoutMsisdn).toBeNull();
      },
    );

    it('records the previous number, the new one and the session', async () => {
      await updateProvider({ payoutMsisdn: PREVIOUS_PAYOUT_NUMBER });

      await withRightPassword().expect(200);

      const [entry] = await auditOf('USER_PAYOUT_NUMBER_CHANGED');
      expect(entry).toMatchObject({
        targetType: 'User',
        targetId: actors.provider.userId,
        metadata: {
          previous: PREVIOUS_PAYOUT_NUMBER,
          current: PAYOUT_NUMBER,
          sessionId: actors.provider.refreshToken.split('.')[0],
        },
      });
    });

    it('warns the device of the owner, with the last digits only', async () => {
      await updateProvider({ pushToken: PUSH_TOKEN });

      await withRightPassword().expect(200);

      expect(pushed).toHaveLength(1);
      expect(pushed[0].to).toBe(PUSH_TOKEN);
      expect(pushed[0].body).toContain('4567');
      expect(pushed[0].body).not.toContain(PAYOUT_NUMBER);
    });

    it('records and warns once when the same number is sent twice', async () => {
      await updateProvider({ pushToken: PUSH_TOKEN });
      await withRightPassword().expect(200);

      await withRightPassword().expect(200);

      expect(await auditOf('USER_PAYOUT_NUMBER_CHANGED')).toHaveLength(1);
      expect(pushed).toHaveLength(1);
    });
  });

  describe('without the current password', () => {
    it('returns 400, keeps the number and keeps the session', async () => {
      const response = await withWrongPassword();

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('AUTH_WRONG_CURRENT_PASSWORD');
      expect((await readProvider()).payoutMsisdn).toBeNull();
      expect(pushed).toHaveLength(0);
      await request(actors.httpServer)
        .get('/api/v1/auth/me')
        .set(authHeader(actors.provider.accessToken))
        .expect(200);
    });

    it('records the refused attempt', async () => {
      await withWrongPassword().expect(400);

      const [entry] = await auditOf('AUTH_PASSWORD_CONFIRMATION_FAILED');
      expect(entry.metadata).toEqual({ operation: 'PAYOUT_NUMBER_CHANGE' });
      expect(await auditOf('USER_PAYOUT_NUMBER_CHANGED')).toHaveLength(0);
    });

    it('returns 400 when the password is missing', async () => {
      const response = await changePayoutNumber({
        payoutMsisdn: PAYOUT_NUMBER,
      });

      expect(response.status).toBe(400);
      expect((await readProvider()).payoutMsisdn).toBeNull();
    });

    it('returns 401 without a session', async () => {
      await request(actors.httpServer)
        .put('/api/v1/users/me/payout-number')
        .send({ payoutMsisdn: PAYOUT_NUMBER, currentPassword: TEST_PASSWORD })
        .expect(401);
    });

    it('is no longer accepted by the profile update', async () => {
      const response = await request(actors.httpServer)
        .patch('/api/v1/users/me')
        .set(authHeader(actors.provider.accessToken))
        .send({ payoutMsisdn: PAYOUT_NUMBER });

      expect(response.status).toBe(400);
      expect((await readProvider()).payoutMsisdn).toBeNull();
    });
  });

  describe('lockout', () => {
    async function failFiveTimes() {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await withWrongPassword().expect(400);
      }
    }

    it('refuses the right password after five wrong ones', async () => {
      await failFiveTimes();

      const response = await withRightPassword();

      expect(response.status).toBe(429);
      expect(response.body.errorCode).toBe('TOO_MANY_REQUESTS');
      expect((await readProvider()).payoutMsisdn).toBeNull();
    });

    it('blocks the login of the number as well', async () => {
      await failFiveTimes();

      await request(actors.httpServer)
        .post('/api/v1/auth/login')
        .send({ phone: actors.seed.provider.phone, password: TEST_PASSWORD })
        .expect(429);
    });

    it('starts counting again after the right password', async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await withWrongPassword().expect(400);
      }
      await withRightPassword().expect(200);

      await withWrongPassword().expect(400);

      await withRightPassword('850000001').expect(200);
    });
  });
});
