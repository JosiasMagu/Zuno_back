import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, VerificationPurpose } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import { NotificationsService } from '../../../shared/notifications/notifications.service';
import {
  VERIFICATION_CODE_MAX_SENDS,
  VERIFICATION_CODE_MAX_WRONG_ATTEMPTS,
  VERIFICATION_CODE_RESEND_SECONDS,
  VERIFICATION_CODE_TTL_MINUTES,
  VERIFICATION_CODE_WINDOW_MINUTES,
} from '../auth.policy';

const CODE_LENGTH = 6;
const BCRYPT_ROUNDS = 10;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const WINDOW_MS = VERIFICATION_CODE_WINDOW_MINUTES * MINUTE_MS;

interface CodeRecipient {
  userId: string;
  phone: string;
  email?: string | null;
  purpose: VerificationPurpose;
}

interface NewCode {
  userId: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: Date;
}

type SendRefusal = 'RESEND_TOO_SOON' | 'HOURLY_LIMIT_REACHED';

/**
 * A mesma resposta para um código errado, expirado ou já usado e para uma
 * conta que não existe: quem tenta não distingue os casos.
 */
export function invalidCodeError(): BadRequestException {
  return new BadRequestException('Código inválido ou expirado.');
}

/**
 * Códigos de uso único para verificar o telefone e redefinir a password.
 *
 * Os limites contam-se por conta e por fim, a partir dos próprios códigos
 * emitidos na última hora. Pedir um código novo não repõe as tentativas.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Emite um código e envia-o. Não faz nada, e não avisa quem pediu, se a
   * conta recebeu um código há menos de um minuto ou já esgotou os envios da
   * hora: o código anterior continua válido.
   */
  async issueCode(recipient: CodeRecipient): Promise<void> {
    const { userId, purpose } = recipient;
    const code = this.generateCode();
    const expiresAt = new Date(
      Date.now() + VERIFICATION_CODE_TTL_MINUTES * MINUTE_MS,
    );
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

    const stored = await this.prisma.$transaction((tx) =>
      this.storeUnlessLimited(tx, { userId, purpose, codeHash, expiresAt }),
    );

    if ('refusal' in stored) {
      this.logger.warn(
        { userId, purpose, reason: stored.refusal },
        'Código de verificação não enviado: limite de envios.',
      );
      return;
    }

    await this.deliver(stored.codeId, { ...recipient, code, expiresAt });
  }

  /**
   * Gasta o código da conta, ou lança. Um código só serve uma vez, e cada
   * código errado conta para o limite da hora.
   */
  async consumeCode(input: {
    userId: string;
    code: string;
    purpose: VerificationPurpose;
  }): Promise<void> {
    await this.assertWrongAttemptsBelowLimit(input.userId, input.purpose);

    const pending = await this.prisma.verificationCode.findFirst({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true },
    });

    if (!pending || !(await this.reserveAttempt(pending.id))) {
      throw invalidCodeError();
    }

    const matches = await bcrypt.compare(input.code, pending.codeHash);

    if (!matches || !(await this.markUsed(pending.id))) {
      throw invalidCodeError();
    }
  }

  /**
   * Guarda o código novo e anula os anteriores, ou devolve o motivo por que
   * a conta não pode receber outro agora.
   */
  private async storeUnlessLimited(
    tx: Prisma.TransactionClient,
    newCode: NewCode,
  ): Promise<{ codeId: string } | { refusal: SendRefusal }> {
    const { userId, purpose } = newCode;

    // Tranca a conta até ao fim da transacção. Sem isto, dois pedidos em
    // simultâneo passavam ambos nos limites e saíam dois códigos.
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;

    const now = new Date();
    const windowStart = new Date(now.getTime() - WINDOW_MS);

    // Os códigos que saíram da janela já expiraram e não contam para nada.
    await tx.verificationCode.deleteMany({
      where: { userId, createdAt: { lt: windowStart } },
    });

    const sentInWindow = await tx.verificationCode.findMany({
      where: { userId, purpose, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const refusal = this.findSendRefusal(
      sentInWindow.map((sent) => sent.createdAt),
      now,
    );
    if (refusal) {
      return { refusal };
    }

    await tx.verificationCode.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: now },
    });

    const created = await tx.verificationCode.create({
      data: newCode,
      select: { id: true },
    });

    return { codeId: created.id };
  }

  /** `sentAt` vem do mais recente para o mais antigo. */
  private findSendRefusal(sentAt: Date[], now: Date): SendRefusal | null {
    if (sentAt.length === 0) {
      return null;
    }

    if (sentAt.length >= VERIFICATION_CODE_MAX_SENDS) {
      return 'HOURLY_LIMIT_REACHED';
    }

    const resendAllowedAt =
      sentAt[0].getTime() + VERIFICATION_CODE_RESEND_SECONDS * SECOND_MS;

    return now.getTime() < resendAllowedAt ? 'RESEND_TOO_SOON' : null;
  }

  /**
   * Um código que não chegou a sair é apagado: não fica válido sem ninguém o
   * ter e não conta para os limites. Quem pediu recebe a resposta de sempre.
   */
  private async deliver(
    codeId: string,
    message: CodeRecipient & { code: string; expiresAt: Date },
  ): Promise<void> {
    try {
      await this.notifications.sendVerificationCode(message);
    } catch (error: unknown) {
      await this.prisma.verificationCode.delete({ where: { id: codeId } });
      this.logger.error(
        { userId: message.userId, purpose: message.purpose, err: error },
        'Falha ao enviar o código de verificação.',
      );
    }
  }

  /** Recusa com 429 quando a conta já errou o código vezes de mais na última hora. */
  private async assertWrongAttemptsBelowLimit(
    userId: string,
    purpose: VerificationPurpose,
  ): Promise<void> {
    const attempted = await this.prisma.verificationCode.findMany({
      where: {
        userId,
        purpose,
        createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
        attempts: { gt: 0 },
      },
      orderBy: { createdAt: 'asc' },
      select: { attempts: true, createdAt: true },
    });

    const wrongAttempts = attempted.reduce(
      (total, code) => total + code.attempts,
      0,
    );
    if (wrongAttempts < VERIFICATION_CODE_MAX_WRONG_ATTEMPTS) {
      return;
    }

    // A contagem baixa quando o código mais antigo com erros sai da janela.
    const retryAt = attempted[0].createdAt.getTime() + WINDOW_MS;
    const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / MINUTE_MS));

    throw new ApiException(
      ErrorCode.TOO_MANY_REQUESTS,
      `Demasiados códigos errados. Tenta novamente dentro de ${minutes} min.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Conta a tentativa antes de comparar o código. Assim, pedidos feitos em
   * simultâneo não conseguem mais tentativas do que o limite.
   */
  private async reserveAttempt(codeId: string): Promise<boolean> {
    const { count } = await this.prisma.verificationCode.updateMany({
      where: {
        id: codeId,
        usedAt: null,
        attempts: { lt: VERIFICATION_CODE_MAX_WRONG_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });

    return count === 1;
  }

  /**
   * Gasta o código e desconta a tentativa reservada, que afinal estava certa.
   * Devolve false se outro pedido o gastou primeiro.
   */
  private async markUsed(codeId: string): Promise<boolean> {
    const { count } = await this.prisma.verificationCode.updateMany({
      where: { id: codeId, usedAt: null },
      data: { usedAt: new Date(), attempts: { decrement: 1 } },
    });

    return count === 1;
  }

  private generateCode(): string {
    return crypto
      .randomInt(0, 10 ** CODE_LENGTH)
      .toString()
      .padStart(CODE_LENGTH, '0');
  }
}
