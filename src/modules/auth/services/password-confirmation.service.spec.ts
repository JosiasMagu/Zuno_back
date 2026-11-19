import { HttpStatus, UnauthorizedException } from '@nestjs/common';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordConfirmationService } from './password-confirmation.service';
import { PasswordHasher } from './password-hasher.service';

const USER_ID = 'user-uuid-001';
const PHONE = '+258840000001';
const PASSWORD = 'gerador-amarelo';
const STORED_HASH = 'stored-hash';

describe('PasswordConfirmationService', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const passwords = { matches: jest.fn() };
  const loginThrottle = {
    assertNotLocked: jest.fn(),
    recordFailure: jest.fn(),
    clear: jest.fn(),
  };
  const audit = { passwordConfirmationFailed: jest.fn() };

  const service = new PasswordConfirmationService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordHasher,
    loginThrottle as unknown as LoginThrottleService,
    audit as unknown as AuthAuditService,
  );

  const confirm = () => service.confirm(USER_ID, PASSWORD, 'PASSWORD_CHANGE');

  /** Faz a confirmação, que tem de falhar, e devolve o erro. */
  const confirmError = async (): Promise<ApiException> => {
    try {
      await confirm();
    } catch (error) {
      return error as ApiException;
    }
    throw new Error('A confirmação devia ter sido recusada.');
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      phone: PHONE,
      passwordHash: STORED_HASH,
    });
    passwords.matches.mockResolvedValue(true);
  });

  it('aceita a password da conta e apaga as falhas anteriores do número', async () => {
    await expect(confirm()).resolves.toEqual({ phone: PHONE });

    expect(passwords.matches).toHaveBeenCalledWith(PASSWORD, STORED_HASH);
    expect(loginThrottle.clear).toHaveBeenCalledWith(PHONE);
    expect(loginThrottle.recordFailure).not.toHaveBeenCalled();
    expect(audit.passwordConfirmationFailed).not.toHaveBeenCalled();
  });

  it('recusa com 400 a password errada, conta a falha e regista-a', async () => {
    passwords.matches.mockResolvedValue(false);

    const error = await confirmError();

    expect(error.getStatus()).toBe(400);
    expect(error.errorCode).toBe(ErrorCode.AUTH_WRONG_CURRENT_PASSWORD);
    expect(loginThrottle.recordFailure).toHaveBeenCalledWith(PHONE);
    expect(loginThrottle.clear).not.toHaveBeenCalled();
    expect(audit.passwordConfirmationFailed).toHaveBeenCalledWith(
      USER_ID,
      'PASSWORD_CHANGE',
    );
  });

  it('nem compara a password quando o número está bloqueado', async () => {
    loginThrottle.assertNotLocked.mockRejectedValue(
      new ApiException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Demasiadas tentativas falhadas.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );

    const error = await confirmError();

    expect(error.getStatus()).toBe(429);
    expect(passwords.matches).not.toHaveBeenCalled();
  });

  it('responde 401 quando a conta da sessão já não existe', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(confirm()).rejects.toThrow(UnauthorizedException);
    expect(passwords.matches).not.toHaveBeenCalled();
  });
});
