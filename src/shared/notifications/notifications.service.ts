import { Inject, Injectable } from '@nestjs/common';

import { VERIFICATION_CODE_SENDER } from './verification-code-sender';
import type {
  VerificationCodeMessage,
  VerificationCodeSender,
} from './verification-code-sender';

/** Envio de mensagens para fora da aplicação, pelo canal configurado. */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(VERIFICATION_CODE_SENDER)
    private readonly codeSender: VerificationCodeSender,
  ) {}

  /** Rejeita quando o canal não aceita a mensagem. */
  sendVerificationCode(message: VerificationCodeMessage): Promise<void> {
    return this.codeSender.send(message);
  }
}
