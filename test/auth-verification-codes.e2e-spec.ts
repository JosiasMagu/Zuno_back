import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { VERIFICATION_CODE_SENDER } from '../src/shared/notifications/verification-code-sender';
import type {
  VerificationCodeMessage,
  VerificationCodeSender,
} from '../src/shared/notifications/verification-code-sender';
import { createTestApp, errorOf } from './helpers/app';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { TEST_PASSWORD } from './helpers/seed-test-data';

const NEW_PASSWORD = 'mangueira-verde';
const UNKNOWN_PHONE = '+258870000000';
const MINUTE = 60;
const HOUR = 60 * MINUTE;

describe('Verification codes E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let sent: VerificationCodeMessage[];
  let providerIsDown: boolean;
  const prisma = () => getTestPrisma();

  // Faz de fornecedor de SMS: guarda o que a aplicação mandou enviar.
  const sender: VerificationCodeSender = {
    send: (message) => {
      if (providerIsDown) {
        return Promise.reject(new Error('fornecedor em baixo'));
      }
      sent.push(message);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(VERIFICATION_CODE_SENDER).useValue(sender),
    );
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
    sent = [];
    providerIsDown = false;
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  function post(path: string, body: Record<string, unknown>) {
    return request(actors.httpServer).post(`/api/v1/auth/${path}`).send(body);
  }

  const forgotPassword = (phone = actors.seed.client.phone) =>
    post('password/forgot', { phone });

  const resetPassword = (code: string, phone = actors.seed.client.phone) =>
    post('password/reset', { phone, code, newPassword: NEW_PASSWORD });

  const login = (password: string) =>
    post('login', { phone: actors.seed.client.phone, password });

  const wrongCodeFor = (message: VerificationCodeMessage) =>
    message.code === '000000' ? '111111' : '000000';

  /** Faz passar tempo pelos códigos do cliente: recua a emissão e a validade. */
  async function letTimePass(seconds: number) {
    const codes = await prisma().verificationCode.findMany({
      where: { userId: actors.client.userId },
    });

    for (const code of codes) {
      await prisma().verificationCode.update({
        where: { id: code.id },
        data: {
          createdAt: new Date(code.createdAt.getTime() - seconds * 1000),
          expiresAt: new Date(code.expiresAt.getTime() - seconds * 1000),
        },
      });
    }
  }

  async function failReset(times: number) {
    const latest = sent[sent.length - 1];
    for (let attempt = 0; attempt < times; attempt += 1) {
      await resetPassword(wrongCodeFor(latest)).expect(400);
    }
  }

  async function markClientAsUnverified() {
    await prisma().user.update({
      where: { id: actors.client.userId },
      data: { isVerified: false },
    });
  }

  describe('password recovery', () => {
    it('sends a six-digit code to the phone of the account', async () => {
      await forgotPassword().expect(201);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        userId: actors.client.userId,
        phone: actors.seed.client.phone,
        purpose: 'PASSWORD_RESET',
      });
      expect(sent[0].code).toMatch(/^\d{6}$/);
      const minutesLeft = (sent[0].expiresAt.getTime() - Date.now()) / 60000;
      expect(minutesLeft).toBeGreaterThan(14);
      expect(minutesLeft).toBeLessThanOrEqual(15);
    });

    it('stores only a hash of the code', async () => {
      await forgotPassword().expect(201);

      const stored = await prisma().verificationCode.findFirstOrThrow({
        where: { userId: actors.client.userId },
      });
      expect(stored.codeHash).not.toContain(sent[0].code);
    });

    it('answers the same for an unknown number, and sends nothing', async () => {
      const known = await forgotPassword();
      const unknown = await forgotPassword(UNKNOWN_PHONE);

      expect(known.status).toBe(201);
      expect(unknown.status).toBe(201);
      expect(unknown.body).toEqual(known.body);
      expect(sent).toHaveLength(1);
    });

    it('does not send a code to a suspended account', async () => {
      await prisma().user.update({
        where: { id: actors.client.userId },
        data: { isActive: false },
      });

      await forgotPassword().expect(201);

      expect(sent).toHaveLength(0);
    });

    it('sets the new password with the code that was sent', async () => {
      await forgotPassword().expect(201);

      await resetPassword(sent[0].code).expect(201);

      await login(NEW_PASSWORD).expect(201);
      await login(TEST_PASSWORD).expect(401);
    });

    it('refuses a code that was already used', async () => {
      await forgotPassword().expect(201);
      await resetPassword(sent[0].code).expect(201);

      await resetPassword(sent[0].code).expect(400);
    });

    it('refuses a code older than fifteen minutes', async () => {
      await forgotPassword().expect(201);
      await letTimePass(15 * MINUTE + 1);

      await resetPassword(sent[0].code).expect(400);

      await login(TEST_PASSWORD).expect(201);
    });

    it('answers the same for a wrong code and for an unknown number', async () => {
      await forgotPassword().expect(201);

      const wrongCode = await resetPassword(wrongCodeFor(sent[0]));
      const unknownNumber = await resetPassword('123456', UNKNOWN_PHONE);

      expect(wrongCode.status).toBe(400);
      expect(errorOf(unknownNumber)).toEqual(errorOf(wrongCode));
    });

    it('refuses a code that was issued to verify the phone', async () => {
      await markClientAsUnverified();
      await post('verify/request', { phone: actors.seed.client.phone }).expect(
        201,
      );

      await resetPassword(sent[0].code).expect(400);
    });
  });

  describe('resend limits', () => {
    async function sendCodes(count: number) {
      for (let index = 0; index < count; index += 1) {
        await forgotPassword().expect(201);
        await letTimePass(MINUTE + 1);
      }
    }

    it('sends no second code within a minute, and the first keeps working', async () => {
      await forgotPassword().expect(201);

      const second = await forgotPassword();

      expect(second.status).toBe(201);
      expect(sent).toHaveLength(1);
      await resetPassword(sent[0].code).expect(201);
    });

    it('sends a new code after a minute and cancels the previous one', async () => {
      await sendCodes(1);

      await forgotPassword().expect(201);

      expect(sent).toHaveLength(2);
      await resetPassword(sent[0].code).expect(400);
      await resetPassword(sent[1].code).expect(201);
    });

    it('sends one code when several requests arrive at the same time', async () => {
      const inParallel = (phone: string) =>
        Promise.all(Array.from({ length: 8 }, () => forgotPassword(phone)));
      // Abre primeiro as ligações à base. Com uma só aberta, os pedidos
      // seguintes ficavam em fila e nunca chegavam a cruzar-se.
      await inParallel(UNKNOWN_PHONE);

      await inParallel(actors.seed.client.phone);

      expect(sent).toHaveLength(1);
    });

    it('stops at five codes in an hour', async () => {
      await sendCodes(5);

      await forgotPassword().expect(201);

      expect(sent).toHaveLength(5);
    });

    it('sends again once the hour has passed, and forgets the old codes', async () => {
      await sendCodes(5);
      await letTimePass(HOUR);

      await forgotPassword().expect(201);

      expect(sent).toHaveLength(6);
      const stored = await prisma().verificationCode.count({
        where: { userId: actors.client.userId },
      });
      expect(stored).toBe(1);
    });

    it('counts each purpose on its own', async () => {
      await markClientAsUnverified();
      await forgotPassword().expect(201);

      await post('verify/request', { phone: actors.seed.client.phone }).expect(
        201,
      );

      expect(sent.map((message) => message.purpose)).toEqual([
        'PASSWORD_RESET',
        'PHONE_VERIFICATION',
      ]);
    });
  });

  describe('wrong codes', () => {
    it('blocks the account after five wrong codes, even for the right one', async () => {
      await forgotPassword().expect(201);
      await failReset(5);

      const response = await resetPassword(sent[0].code);

      expect(response.status).toBe(429);
      expect(response.body.errorCode).toBe('TOO_MANY_REQUESTS');
      await login(TEST_PASSWORD).expect(201);
    });

    it('gives no extra attempts to requests that arrive at the same time', async () => {
      await forgotPassword().expect(201);
      const wrongCode = wrongCodeFor(sent[0]);

      await Promise.all(
        Array.from({ length: 8 }, () => resetPassword(wrongCode)),
      );

      const stored = await prisma().verificationCode.findFirstOrThrow({
        where: { userId: actors.client.userId },
      });
      expect(stored.attempts).toBe(5);
      await resetPassword(sent[0].code).expect(429);
    });

    it('keeps counting when a new code is requested', async () => {
      await forgotPassword().expect(201);
      await failReset(3);
      await letTimePass(MINUTE + 1);
      await forgotPassword().expect(201);
      await failReset(2);

      await resetPassword(sent[1].code).expect(429);
    });

    it('does not count a right code as a wrong one', async () => {
      await forgotPassword().expect(201);
      await failReset(4);
      await resetPassword(sent[0].code).expect(201);
      await letTimePass(MINUTE + 1);
      await forgotPassword().expect(201);

      await resetPassword(sent[1].code).expect(201);
    });

    it('lets the account try again after an hour', async () => {
      await forgotPassword().expect(201);
      await failReset(5);
      await letTimePass(HOUR);
      await forgotPassword().expect(201);

      await resetPassword(sent[1].code).expect(201);
    });
  });

  describe('phone verification', () => {
    const requestVerification = () =>
      post('verify/request', { phone: actors.seed.client.phone });

    it('marks the account as verified with the code that was sent', async () => {
      await markClientAsUnverified();
      await requestVerification().expect(201);

      await post('verify/confirm', {
        phone: actors.seed.client.phone,
        code: sent[0].code,
      }).expect(201);

      const user = await prisma().user.findUniqueOrThrow({
        where: { id: actors.client.userId },
      });
      expect(sent[0].purpose).toBe('PHONE_VERIFICATION');
      expect(user.isVerified).toBe(true);
    });

    it('leaves the account unverified after a wrong code', async () => {
      await markClientAsUnverified();
      await requestVerification().expect(201);

      await post('verify/confirm', {
        phone: actors.seed.client.phone,
        code: wrongCodeFor(sent[0]),
      }).expect(400);

      const user = await prisma().user.findUniqueOrThrow({
        where: { id: actors.client.userId },
      });
      expect(user.isVerified).toBe(false);
    });

    it('does not send a code to an account that is already verified', async () => {
      await requestVerification().expect(201);

      expect(sent).toHaveLength(0);
    });
  });

  describe('delivery failure', () => {
    it('answers as usual and leaves no code behind', async () => {
      const delivered = await forgotPassword();
      await letTimePass(HOUR);
      providerIsDown = true;

      const failed = await forgotPassword();

      expect(failed.status).toBe(201);
      expect(failed.body).toEqual(delivered.body);
      const pending = await prisma().verificationCode.count({
        where: { userId: actors.client.userId, usedAt: null },
      });
      expect(pending).toBe(0);
    });

    it('does not make the account wait a minute for the next request', async () => {
      providerIsDown = true;
      await forgotPassword().expect(201);
      providerIsDown = false;

      await forgotPassword().expect(201);

      expect(sent).toHaveLength(1);
    });
  });
});
