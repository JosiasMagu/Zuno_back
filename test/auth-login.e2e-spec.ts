import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { createTestApp, errorOf } from './helpers/app';
import { authHeader } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { hashTestPassword, TEST_PASSWORD } from './helpers/seed-test-data';

const NEW_PHONE = '+258841234567';
const NEW_PASSWORD = 'mangueira-verde';

describe('Registration and login E2E', () => {
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

  function register(overrides: Record<string, unknown> = {}) {
    return request(actors.httpServer)
      .post('/api/v1/auth/register')
      .send({
        name: 'Nova Conta',
        phone: NEW_PHONE,
        password: NEW_PASSWORD,
        ...overrides,
      });
  }

  function login(phone: string, password: string) {
    return request(actors.httpServer)
      .post('/api/v1/auth/login')
      .send({ phone, password });
  }

  async function failLogin(phone: string, times: number) {
    for (let attempt = 0; attempt < times; attempt += 1) {
      await login(phone, 'password-errada').expect(401);
    }
  }

  describe('registration', () => {
    it('stores the phone in E.164 whatever way it was typed', async () => {
      const response = await register({ phone: '84 123 4567' });

      expect(response.status).toBe(201);
      expect(response.body.user.phone).toBe(NEW_PHONE);
      const user = await prisma().user.findUniqueOrThrow({
        where: { phone: NEW_PHONE },
      });
      expect(user.name).toBe('Nova Conta');
    });

    it.each(['841234567', '258841234567', '00258 84 123-4567'])(
      'refuses %p when the number already has an account',
      async (phone) => {
        await register().expect(201);

        const response = await register({ phone });

        expect(response.status).toBe(400);
        expect(await prisma().user.count({ where: { phone: NEW_PHONE } })).toBe(
          1,
        );
      },
    );

    it.each(['21123456', '811234567', '8412345', 'admin', '+27841234567'])(
      'returns 400 for the phone %p',
      async (phone) => {
        const response = await register({ phone });

        expect(response.status).toBe(400);
      },
    );

    it.each([
      ['shorter than 8 characters', 'abc1234'],
      ['one of the most used', 'Password123'],
      ['the phone number itself', '841234567'],
      ['longer than bcrypt reads', 'a'.repeat(73)],
    ])('returns 400 for a password that is %s', async (_rule, password) => {
      const response = await register({ password });

      expect(response.status).toBe(400);
      expect(await prisma().user.count({ where: { phone: NEW_PHONE } })).toBe(
        0,
      );
    });

    it('accepts a long enough password with no digits or capitals', async () => {
      const response = await register({ password: 'mangueira' });

      expect(response.status).toBe(201);
    });

    it('stores only a bcrypt hash of the password', async () => {
      await register().expect(201);

      const user = await prisma().user.findUniqueOrThrow({
        where: { phone: NEW_PHONE },
      });
      expect(user.passwordHash).not.toContain(NEW_PASSWORD);
      expect(await bcrypt.compare(NEW_PASSWORD, user.passwordHash)).toBe(true);
      expect(bcrypt.getRounds(user.passwordHash)).toBe(
        Number(process.env.PASSWORD_HASH_ROUNDS),
      );
    });
  });

  describe('login', () => {
    it.each([
      '840000902',
      '+258840000902',
      '258 84 000 0902',
      '00258840000902',
    ])('signs in with the phone typed as %p', async (phone) => {
      const response = await login(phone, TEST_PASSWORD);

      expect(response.status).toBe(201);
      expect(response.body.user.id).toBe(actors.client.userId);
      await request(actors.httpServer)
        .get('/api/v1/auth/me')
        .set(authHeader(response.body.accessToken as string))
        .expect(200);
    });

    it('answers the same for a wrong password and for an unknown number', async () => {
      const wrongPassword = await login(
        actors.seed.client.phone,
        'password-errada',
      );
      const unknownNumber = await login('+258870000000', 'password-errada');

      expect(wrongPassword.status).toBe(401);
      expect(errorOf(unknownNumber)).toEqual(errorOf(wrongPassword));
    });

    it('tells only the right password that the account is suspended', async () => {
      await prisma().user.update({
        where: { id: actors.client.userId },
        data: { isActive: false },
      });

      const rightPassword = await login(
        actors.seed.client.phone,
        TEST_PASSWORD,
      );
      const wrongPassword = await login(
        actors.seed.client.phone,
        'password-errada',
      );

      expect(rightPassword.status).toBe(403);
      expect(wrongPassword.status).toBe(401);
    });

    it('lets an old account with a phone that cannot be normalised sign in', async () => {
      await prisma().user.create({
        data: {
          phone: 'admin',
          name: 'Conta Antiga',
          passwordHash: await hashTestPassword(),
        },
      });

      const response = await login('admin', TEST_PASSWORD);

      expect(response.status).toBe(201);
    });
  });

  describe('lockout', () => {
    it('blocks the number after five failures, even for the right password', async () => {
      const { phone } = actors.seed.client;
      await failLogin(phone, 5);

      const response = await login(phone, TEST_PASSWORD);

      expect(response.status).toBe(429);
      expect(response.body.errorCode).toBe('TOO_MANY_REQUESTS');
    });

    it('blocks an unknown number exactly as it blocks a registered one', async () => {
      await failLogin(actors.seed.client.phone, 5);
      await failLogin('+258870000000', 5);

      const registered = await login(actors.seed.client.phone, 'qualquer-uma');
      const unknown = await login('+258870000000', 'qualquer-uma');

      expect(unknown.status).toBe(429);
      expect(errorOf(unknown)).toEqual(errorOf(registered));
    });

    it('does not block the other accounts', async () => {
      await failLogin(actors.seed.client.phone, 5);

      await login(actors.seed.provider.phone, TEST_PASSWORD).expect(201);
    });

    it('lets the number in again when the lock expires', async () => {
      const { phone } = actors.seed.client;
      await failLogin(phone, 5);
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      await prisma().loginThrottle.update({
        where: { phone },
        data: { lockedUntil: longAgo, windowStartedAt: longAgo },
      });

      await login(phone, TEST_PASSWORD).expect(201);
      expect(await prisma().loginThrottle.count({ where: { phone } })).toBe(0);
    });

    it('starts counting again after a successful login', async () => {
      const { phone } = actors.seed.client;
      await failLogin(phone, 4);
      await login(phone, TEST_PASSWORD).expect(201);

      await failLogin(phone, 4);

      await login(phone, TEST_PASSWORD).expect(201);
    });

    it('forgets failures older than the counting window', async () => {
      const { phone } = actors.seed.client;
      await failLogin(phone, 4);
      await prisma().loginThrottle.update({
        where: { phone },
        data: { windowStartedAt: new Date(Date.now() - 16 * 60 * 1000) },
      });

      await failLogin(phone, 4);

      await login(phone, TEST_PASSWORD).expect(201);
    });
  });

  describe('password recovery', () => {
    it('finds the account whatever way the phone is typed', async () => {
      await request(actors.httpServer)
        .post('/api/v1/auth/password/forgot')
        .send({ phone: '84 000 0902' })
        .expect(201);

      const codes = await prisma().verificationCode.count({
        where: { userId: actors.client.userId, purpose: 'PASSWORD_RESET' },
      });
      expect(codes).toBe(1);
    });
  });
});
