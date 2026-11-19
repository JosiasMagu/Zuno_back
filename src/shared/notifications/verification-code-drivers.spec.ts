import { Logger } from '@nestjs/common';
import { VerificationPurpose } from '@prisma/client';

import {
  createVerificationCodeSender,
  LogVerificationCodeSender,
  resolveNotificationDriver,
  SilentVerificationCodeSender,
} from './verification-code-drivers';
import { VerificationCodeMessage } from './verification-code-sender';

const message: VerificationCodeMessage = {
  userId: 'user-1',
  phone: '+258840000902',
  code: '482913',
  purpose: VerificationPurpose.PASSWORD_RESET,
  expiresAt: new Date('2026-11-13T10:15:00Z'),
};

describe('drivers dos códigos de verificação', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('resolveNotificationDriver()', () => {
    it.each(['log', 'silent'])(
      'usa %p quando é o que está configurado',
      (configured) => {
        expect(resolveNotificationDriver(configured, 'production')).toBe(
          configured,
        );
      },
    );

    it('sem configuração, só escreve no log em desenvolvimento', () => {
      expect(resolveNotificationDriver(undefined, 'development')).toBe('log');
      expect(resolveNotificationDriver(undefined, 'test')).toBe('silent');
      expect(resolveNotificationDriver(undefined, 'production')).toBe('silent');
    });
  });

  describe('createVerificationCodeSender()', () => {
    it('devolve o driver log quando é pedido', () => {
      expect(createVerificationCodeSender('log', 'development')).toBeInstanceOf(
        LogVerificationCodeSender,
      );
    });

    it('devolve o driver silent em produção sem configuração, e avisa', () => {
      const sender = createVerificationCodeSender(undefined, 'production');

      expect(sender).toBeInstanceOf(SilentVerificationCodeSender);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('não são entregues'),
      );
    });

    it('não avisa quando o driver silent é usado fora de produção', () => {
      createVerificationCodeSender('silent', 'test');

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('o driver log escreve o código no log', async () => {
    await new LogVerificationCodeSender().send(message);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: '482913', phone: '+258840000902' }),
      expect.any(String),
    );
  });

  it('o driver silent não escreve nada', async () => {
    await new SilentVerificationCodeSender().send();

    expect(warn).not.toHaveBeenCalled();
  });
});
