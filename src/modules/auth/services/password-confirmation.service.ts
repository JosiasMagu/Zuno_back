import { Injectable, UnauthorizedException } from '@nestjs/common';

import { ApiErrors } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import type { PasswordProtectedOperation } from './auth-audit.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordHasher } from './password-hasher.service';

/**
 * Confirma a password de quem já tem sessão, antes de uma operação que uma
 * sessão roubada não deve conseguir fazer sozinha.
 *
 * Os erros somam-se às falhas de login do número e bloqueiam-no da mesma
 * maneira, para estas rotas não servirem para adivinhar a password.
 */
@Injectable()
export class PasswordConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly loginThrottle: LoginThrottleService,
    private readonly audit: AuthAuditService,
  ) {}

  /**
   * Devolve o telefone da conta confirmada. Lança 400 se a password não for
   * a da conta e 429 se o número estiver bloqueado por tentativas falhadas.
   */
  async confirm(
    userId: string,
    password: string,
    operation: PasswordProtectedOperation,
  ): Promise<{ phone: string }> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, passwordHash: true },
    });

    if (!account) {
      throw new UnauthorizedException('Sessão inválida.');
    }

    await this.loginThrottle.assertNotLocked(account.phone);

    if (await this.passwords.matches(password, account.passwordHash)) {
      await this.loginThrottle.clear(account.phone);
      return { phone: account.phone };
    }

    await this.loginThrottle.recordFailure(account.phone);
    await this.audit.passwordConfirmationFailed(userId, operation);

    throw ApiErrors.badRequest(
      ErrorCode.AUTH_WRONG_CURRENT_PASSWORD,
      'Password actual incorrecta.',
    );
  }
}
