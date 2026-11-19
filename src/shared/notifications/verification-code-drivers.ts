import { Logger } from '@nestjs/common';

import {
  NotificationDriver,
  VerificationCodeMessage,
  VerificationCodeSender,
} from './verification-code-sender';

/**
 * Escreve o código no log, para quem está a desenvolver o poder ler sem
 * fornecedor de SMS. A validação do ambiente recusa este driver em produção.
 */
export class LogVerificationCodeSender implements VerificationCodeSender {
  private readonly logger = new Logger(LogVerificationCodeSender.name);

  send(message: VerificationCodeMessage): Promise<void> {
    this.logger.warn(
      {
        userId: message.userId,
        phone: message.phone,
        purpose: message.purpose,
        code: message.code,
        expiresAt: message.expiresAt,
      },
      'Código de verificação (driver log, só para desenvolvimento).',
    );

    return Promise.resolve();
  }
}

/** Não entrega o código a ninguém nem o escreve em lado nenhum. */
export class SilentVerificationCodeSender implements VerificationCodeSender {
  send(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Sem NOTIFICATIONS_DRIVER definido, só o ambiente de desenvolvimento escreve
 * os códigos no log. Nos outros, a omissão é não os mostrar.
 */
export function resolveNotificationDriver(
  configured: string | undefined,
  nodeEnv: string | undefined,
): NotificationDriver {
  if (configured) {
    return configured as NotificationDriver;
  }

  return nodeEnv === 'development' ? 'log' : 'silent';
}

export function createVerificationCodeSender(
  configured: string | undefined,
  nodeEnv: string | undefined,
): VerificationCodeSender {
  const driver = resolveNotificationDriver(configured, nodeEnv);

  if (driver === 'log') {
    return new LogVerificationCodeSender();
  }

  if (nodeEnv === 'production') {
    new Logger('Notifications').warn(
      'NOTIFICATIONS_DRIVER=silent: os códigos de verificação não são entregues. A recuperação de password e a verificação do telefone não funcionam até haver um fornecedor.',
    );
  }

  return new SilentVerificationCodeSender();
}
