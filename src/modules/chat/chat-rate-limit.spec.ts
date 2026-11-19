import { HttpException } from '@nestjs/common';

import { CHAT_MESSAGES_PER_MINUTE } from '../../shared/constants/policy';
import { ChatRateLimiter, takeSlot } from './chat-rate-limit';

const MINUTE_MS = 60 * 1000;
const NOW = 1_800_000_000_000;

describe('takeSlot', () => {
  it('deixa passar a primeira mensagem e regista-a', () => {
    expect(takeSlot([], NOW, 3, MINUTE_MS)).toEqual({
      allowed: true,
      recent: [NOW],
    });
  });

  it('recusa a mensagem que passa o limite dentro da janela', () => {
    const recent = [NOW - 3000, NOW - 2000, NOW - 1000];

    expect(takeSlot(recent, NOW, 3, MINUTE_MS)).toEqual({
      allowed: false,
      recent,
    });
  });

  it('deixa passar outra vez quando a mais antiga sai da janela', () => {
    const recent = [NOW - MINUTE_MS, NOW - 2000, NOW - 1000];

    expect(takeSlot(recent, NOW, 3, MINUTE_MS)).toEqual({
      allowed: true,
      recent: [NOW - 2000, NOW - 1000, NOW],
    });
  });

  it('não conta uma mensagem recusada', () => {
    const recent = [NOW - 2000, NOW - 1000];

    const refused = takeSlot(recent, NOW, 2, MINUTE_MS);

    expect(refused.recent).toHaveLength(2);
  });
});

describe('ChatRateLimiter', () => {
  let limiter: ChatRateLimiter;

  const post = (userId: string, times: number, at = NOW) => {
    for (let sent = 0; sent < times; sent += 1) {
      limiter.assertMayPost(userId, at + sent);
    }
  };

  beforeEach(() => {
    limiter = new ChatRateLimiter();
  });

  it('deixa enviar até ao limite por minuto', () => {
    expect(() => post('ana', CHAT_MESSAGES_PER_MINUTE)).not.toThrow();
  });

  it('responde 429 à mensagem seguinte', () => {
    post('ana', CHAT_MESSAGES_PER_MINUTE);

    let refusal: unknown;
    try {
      limiter.assertMayPost('ana', NOW + 1000);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(429);
  });

  it('conta cada utilizador à parte', () => {
    post('ana', CHAT_MESSAGES_PER_MINUTE);

    expect(() => limiter.assertMayPost('rui', NOW + 1000)).not.toThrow();
  });

  it('volta a deixar enviar um minuto depois', () => {
    post('ana', CHAT_MESSAGES_PER_MINUTE);

    expect(() =>
      limiter.assertMayPost('ana', NOW + MINUTE_MS + CHAT_MESSAGES_PER_MINUTE),
    ).not.toThrow();
  });
});
