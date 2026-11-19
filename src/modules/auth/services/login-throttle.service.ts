import { HttpStatus, Injectable } from '@nestjs/common';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import {
  LOGIN_FAILURE_WINDOW_MINUTES,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
} from '../auth.policy';

const MINUTE_MS = 60 * 1000;

/**
 * Bloqueio de login por tentativas falhadas.
 *
 * Conta-se pelo número de telefone, exista ou não a conta: assim o limite
 * não depende do IP de quem tenta, e a resposta é a mesma para um número
 * registado e para um que não o está.
 */
@Injectable()
export class LoginThrottleService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recusa com 429 enquanto o número estiver bloqueado. */
  async assertNotLocked(phone: string): Promise<void> {
    const throttle = await this.prisma.loginThrottle.findUnique({
      where: { phone },
      select: { lockedUntil: true },
    });

    const remainingMs = (throttle?.lockedUntil?.getTime() ?? 0) - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    const minutes = Math.ceil(remainingMs / MINUTE_MS);
    throw new ApiException(
      ErrorCode.TOO_MANY_REQUESTS,
      `Demasiadas tentativas falhadas. Tenta novamente dentro de ${minutes} min.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Soma uma falha ao número e bloqueia-o ao atingir o limite. */
  async recordFailure(phone: string): Promise<void> {
    const now = new Date();
    await this.deleteExpired(now);

    const throttle = await this.prisma.loginThrottle.upsert({
      where: { phone },
      create: { phone, failedAttempts: 1, windowStartedAt: now },
      update: { failedAttempts: { increment: 1 } },
    });

    if (throttle.failedAttempts >= LOGIN_MAX_FAILED_ATTEMPTS) {
      await this.prisma.loginThrottle.update({
        where: { phone },
        data: {
          lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MINUTES * MINUTE_MS),
        },
      });
    }
  }

  /** Um login bem sucedido apaga as falhas anteriores do número. */
  async clear(phone: string): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({ where: { phone } });
  }

  /**
   * Apaga as contagens cuja janela já passou e que não estão bloqueadas. É
   * isto que faz a contagem recomeçar, e mantém a tabela pequena.
   */
  private async deleteExpired(now: Date): Promise<void> {
    const windowStart = new Date(
      now.getTime() - LOGIN_FAILURE_WINDOW_MINUTES * MINUTE_MS,
    );

    await this.prisma.loginThrottle.deleteMany({
      where: {
        windowStartedAt: { lt: windowStart },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    });
  }
}
