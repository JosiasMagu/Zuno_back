import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import type { SessionOrigin } from './sessions.service';

export type LoginFailureReason = 'WRONG_PASSWORD' | 'ACCOUNT_SUSPENDED';

/** Operações que pedem a password actual a quem já tem sessão. */
export type PasswordProtectedOperation =
  | 'PASSWORD_CHANGE'
  | 'PAYOUT_NUMBER_CHANGE';

function originMetadata(origin: SessionOrigin) {
  return {
    ipAddress: origin.ipAddress ?? null,
    userAgent: origin.userAgent ?? null,
  };
}

/**
 * O que fica em auditoria sobre o acesso às contas.
 *
 * Em todos os registos o `actorId` é a conta em causa, mesmo quando quem
 * tentou não chegou a autenticar-se: é por ela que depois se procura. Uma
 * tentativa de login num número sem conta não tem a quem ser atribuída e não
 * fica registada aqui.
 */
@Injectable()
export class AuthAuditService {
  constructor(private readonly audit: AuditService) {}

  loginSucceeded(userId: string, sessionId: string, origin: SessionOrigin) {
    return this.audit.record({
      action: AuditAction.AUTH_LOGIN_SUCCEEDED,
      actorId: userId,
      targetType: 'AuthSession',
      targetId: sessionId,
      metadata: originMetadata(origin),
    });
  }

  loginFailed(
    userId: string,
    reason: LoginFailureReason,
    origin: SessionOrigin,
  ) {
    return this.audit.record({
      action: AuditAction.AUTH_LOGIN_FAILED,
      actorId: userId,
      targetType: 'User',
      targetId: userId,
      metadata: { reason, ...originMetadata(origin) },
    });
  }

  passwordChanged(userId: string, sessionId: string) {
    return this.audit.record({
      action: AuditAction.AUTH_PASSWORD_CHANGED,
      actorId: userId,
      targetType: 'User',
      targetId: userId,
      metadata: { sessionId },
    });
  }

  passwordReset(userId: string, origin: SessionOrigin) {
    return this.audit.record({
      action: AuditAction.AUTH_PASSWORD_RESET,
      actorId: userId,
      targetType: 'User',
      targetId: userId,
      metadata: originMetadata(origin),
    });
  }

  passwordConfirmationFailed(
    userId: string,
    operation: PasswordProtectedOperation,
  ) {
    return this.audit.record({
      action: AuditAction.AUTH_PASSWORD_CONFIRMATION_FAILED,
      actorId: userId,
      targetType: 'User',
      targetId: userId,
      metadata: { operation },
    });
  }
}
