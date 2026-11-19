import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import {
  CHAT_MESSAGES_PER_MINUTE,
  CHAT_NEW_CONVERSATIONS_PER_DAY,
} from '../../shared/constants/policy';

const MINUTE_MS = 60 * 1000;

/**
 * Regista uma mensagem de `userId` e diz se ela cabe no limite. `recent` são
 * os instantes das mensagens anteriores dele. Só conta a última janela: o
 * que é mais antigo sai da lista.
 */
export function takeSlot(
  recent: number[],
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; recent: number[] } {
  const inWindow = recent.filter((sentAt) => now - sentAt < windowMs);

  if (inWindow.length >= limit) {
    return { allowed: false, recent: inWindow };
  }

  return { allowed: true, recent: [...inWindow, now] };
}

/**
 * Quantas mensagens cada utilizador pode enviar por minuto, pelo REST e pelo
 * socket juntos. A chave é a conta e não o IP: o limite global por IP não
 * chega ao socket, e atrás da rede de um operador muitos utilizadores
 * partilham o mesmo IP.
 *
 * Os contadores vivem em memória, por instância. Com várias instâncias o
 * limite efectivo é o deste valor vezes o número delas.
 */
@Injectable()
export class ChatRateLimiter {
  private readonly sentAt = new Map<string, number[]>();

  /** Lança 429 quando o utilizador passou o limite de mensagens por minuto. */
  assertMayPost(userId: string, now: number = Date.now()): void {
    const { allowed, recent } = takeSlot(
      this.sentAt.get(userId) ?? [],
      now,
      CHAT_MESSAGES_PER_MINUTE,
      MINUTE_MS,
    );

    this.sentAt.set(userId, recent);

    if (!allowed) {
      throw tooManyRequests(
        'Estás a enviar mensagens depressa de mais. Espera um pouco e tenta de novo.',
      );
    }

    this.forgetIdleUsers(now);
  }

  /** Esquece quem não escreve há mais de um minuto, para o mapa não crescer. */
  private forgetIdleUsers(now: number): void {
    if (this.sentAt.size < 1000) {
      return;
    }

    for (const [userId, recent] of this.sentAt) {
      if (recent.every((sentAt) => now - sentAt >= MINUTE_MS)) {
        this.sentAt.delete(userId);
      }
    }
  }
}

export function tooManyRequests(message: string): HttpException {
  return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
}

/** Mensagem para quem abriu conversas a mais num dia. */
export const TOO_MANY_NEW_CONVERSATIONS = `Abriste muitas conversas novas hoje. O limite são ${CHAT_NEW_CONVERSATIONS_PER_DAY} por dia.`;
