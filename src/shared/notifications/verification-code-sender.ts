import type { VerificationPurpose } from '@prisma/client';

/** Valores aceites em NOTIFICATIONS_DRIVER. */
export const NOTIFICATION_DRIVERS = ['log', 'silent'] as const;

export type NotificationDriver = (typeof NOTIFICATION_DRIVERS)[number];

/** O que um canal precisa para fazer chegar um código à pessoa. */
export interface VerificationCodeMessage {
  userId: string;
  phone: string;
  email?: string | null;
  code: string;
  purpose: VerificationPurpose;
  expiresAt: Date;
}

/**
 * Canal de entrega dos códigos de verificação.
 *
 * Para ligar um fornecedor de SMS ou de e-mail: criar uma classe que
 * implemente esta interface, dar-lhe um nome em NOTIFICATION_DRIVERS e
 * devolvê-la em createVerificationCodeSender.
 *
 * `send` tem de rejeitar quando o fornecedor não aceita a mensagem. Quem
 * chama anula o código que não chegou a sair.
 */
export interface VerificationCodeSender {
  send(message: VerificationCodeMessage): Promise<void>;
}

/** Token de injecção do canal escolhido por NOTIFICATIONS_DRIVER. */
export const VERIFICATION_CODE_SENDER = Symbol('VERIFICATION_CODE_SENDER');
