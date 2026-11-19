import { createHash } from 'crypto';

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { LiveConnections } from '../../../shared/realtime/live-connections';
import { SessionsService } from './sessions.service';

const USER_ID = 'user-uuid-001';
const SESSION_ID = 'session-uuid-001';
const CURRENT_SECRET = 'current-secret';
const PREVIOUS_SECRET = 'previous-secret';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const tokenFor = (secret: string) => `${SESSION_ID}.${secret}`;

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  userId: USER_ID,
  refreshTokenHash: sha256(CURRENT_SECRET),
  previousTokenHash: null,
  rotatedAt: null,
  userAgent: null,
  ipAddress: null,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  revokedAt: null,
  createdAt: new Date(),
  user: { isActive: true },
  ...overrides,
});

/** Uma sessão cujo token anterior foi trocado há `secondsAgo` segundos. */
const makeRotatedSession = (secondsAgo: number) =>
  makeSession({
    previousTokenHash: sha256(PREVIOUS_SECRET),
    rotatedAt: new Date(Date.now() - secondsAgo * 1000),
  });

const makePrisma = () => ({
  authSession: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

describe('SessionsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let audit: { record: jest.Mock };
  // As ligações em tempo real que as revogações fecham.
  const live = { closeSession: jest.fn(), closeUser: jest.fn() };

  const makeService = (env: Record<string, string> = {}) =>
    new SessionsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      { get: (key: string) => env[key] } as unknown as ConfigService,
      live as unknown as LiveConnections,
    );

  /** Os dados com que a sessão foi revogada, ou undefined se não foi. */
  const revocation = () =>
    prisma.authSession.updateMany.mock.calls
      .map(([args]) => args as { data: { revokedAt?: Date } })
      .find((args) => args.data.revokedAt);

  beforeEach(() => {
    prisma = makePrisma();
    audit = { record: jest.fn() };
  });

  describe('configuração', () => {
    it('recusa uma duração de sessão que não se consegue ler', () => {
      expect(() => makeService({ JWT_REFRESH_EXPIRES_IN: 'sempre' })).toThrow(
        /JWT_REFRESH_EXPIRES_IN/,
      );
    });
  });

  describe('open()', () => {
    beforeEach(() => {
      prisma.authSession.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: SESSION_ID, ...data }),
      );
    });

    it('guarda o SHA-256 do segredo e devolve o token em claro uma só vez', async () => {
      const issued = await makeService().open(USER_ID);

      const [sessionId, secret] = issued.refreshToken.split('.');
      const { data } = prisma.authSession.create.mock.calls[0][0];
      expect(sessionId).toBe(SESSION_ID);
      expect(data.refreshTokenHash).toBe(sha256(secret));
      expect(JSON.stringify(data)).not.toContain(secret);
    });

    it('usa a duração configurada para a sessão', async () => {
      await makeService({ JWT_REFRESH_EXPIRES_IN: '1d' }).open(USER_ID);

      const { data } = prisma.authSession.create.mock.calls[0][0];
      const hours = (data.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it('regista a origem do pedido e corta um user-agent demasiado longo', async () => {
      await makeService().open(USER_ID, {
        ipAddress: '197.218.0.1',
        userAgent: 'x'.repeat(400),
      });

      const { data } = prisma.authSession.create.mock.calls[0][0];
      expect(data.ipAddress).toBe('197.218.0.1');
      expect(data.userAgent).toHaveLength(255);
    });

    it('apaga as sessões antigas do utilizador que já acabaram', async () => {
      await makeService().open(USER_ID);

      const { where } = prisma.authSession.deleteMany.mock.calls[0][0];
      expect(where.userId).toBe(USER_ID);
      expect(where.OR).toEqual([
        { expiresAt: { lt: expect.any(Date) } },
        { revokedAt: { lt: expect.any(Date) } },
      ]);
    });
  });

  describe('rotate()', () => {
    it('troca o token actual por outro e guarda o anterior', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeSession());

      const issued = await makeService().rotate(tokenFor(CURRENT_SECRET));

      const [, newSecret] = issued.refreshToken.split('.');
      expect(newSecret).not.toBe(CURRENT_SECRET);
      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: {
          id: SESSION_ID,
          revokedAt: null,
          refreshTokenHash: sha256(CURRENT_SECRET),
        },
        data: {
          refreshTokenHash: sha256(newSecret),
          previousTokenHash: sha256(CURRENT_SECRET),
          rotatedAt: expect.any(Date),
          expiresAt: expect.any(Date),
        },
      });
    });

    it('aceita o token anterior dentro da tolerância', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeRotatedSession(5));

      await expect(
        makeService().rotate(tokenFor(PREVIOUS_SECRET)),
      ).resolves.toMatchObject({ sessionId: SESSION_ID });
      expect(revocation()).toBeUndefined();
    });

    it('revoga a sessão e regista em auditoria quando o token anterior volta fora da tolerância', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeRotatedSession(31));

      await expect(
        makeService().rotate(tokenFor(PREVIOUS_SECRET)),
      ).rejects.toThrow(UnauthorizedException);

      expect(revocation()).toBeDefined();
      expect(audit.record).toHaveBeenCalledWith({
        action: 'AUTH_REFRESH_TOKEN_REUSED',
        actorId: USER_ID,
        targetType: 'AuthSession',
        targetId: SESSION_ID,
      });
    });

    it('com a tolerância a zero, o token anterior revoga logo a sessão', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeRotatedSession(1));
      const strict = makeService({ REFRESH_TOKEN_REUSE_GRACE_SECONDS: '0' });

      await expect(strict.rotate(tokenFor(PREVIOUS_SECRET))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(revocation()).toBeDefined();
    });

    it('volta a avaliar o token quando outro pedido renovou a sessão primeiro', async () => {
      const afterOtherRequest = makeSession({
        refreshTokenHash: sha256('secret-of-the-other-request'),
        previousTokenHash: sha256(CURRENT_SECRET),
        rotatedAt: new Date(),
      });
      prisma.authSession.findUnique
        .mockResolvedValueOnce(makeSession())
        .mockResolvedValueOnce(afterOtherRequest);
      prisma.authSession.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      await expect(
        makeService().rotate(tokenFor(CURRENT_SECRET)),
      ).resolves.toMatchObject({ sessionId: SESSION_ID });
      expect(prisma.authSession.findUnique).toHaveBeenCalledTimes(2);
    });

    it('desiste com 401 se a segunda tentativa também perder a corrida', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeSession());
      prisma.authSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        makeService().rotate(tokenFor(CURRENT_SECRET)),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.authSession.findUnique).toHaveBeenCalledTimes(2);
    });

    it('revoga a sessão de uma conta desactivada', async () => {
      prisma.authSession.findUnique.mockResolvedValue(
        makeSession({ user: { isActive: false } }),
      );

      await expect(
        makeService().rotate(tokenFor(CURRENT_SECRET)),
      ).rejects.toThrow('Conta desativada.');
      expect(revocation()).toBeDefined();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(['', '   ', 'sem-separador', '.so-segredo', `${SESSION_ID}.`])(
      'recusa o token mal formado %p sem ir à base',
      async (token) => {
        await expect(makeService().rotate(token)).rejects.toThrow(
          UnauthorizedException,
        );
        expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
      },
    );
  });

  describe('revokeAllForUser()', () => {
    it('termina todas as sessões activas do utilizador', async () => {
      prisma.authSession.updateMany.mockResolvedValue({ count: 3 });

      const revoked = await makeService().revokeAllForUser(USER_ID);

      expect(revoked).toBe(3);
      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('deixa de fora a sessão indicada', async () => {
      await makeService().revokeAllForUser(USER_ID, {
        exceptSessionId: SESSION_ID,
      });

      const { where } = prisma.authSession.updateMany.mock.calls[0][0];
      expect(where).toEqual({
        userId: USER_ID,
        revokedAt: null,
        id: { not: SESSION_ID },
      });
    });
  });

  describe('findUsable()', () => {
    it('devolve a sessão aberta', async () => {
      const session = makeSession();
      prisma.authSession.findUnique.mockResolvedValue(session);

      await expect(makeService().findUsable(SESSION_ID)).resolves.toBe(session);
    });

    it.each([
      ['inexistente', null],
      ['revogada', makeSession({ revokedAt: new Date() })],
      ['expirada', makeSession({ expiresAt: new Date(Date.now() - 1000) })],
    ])('devolve null para uma sessão %s', async (_state, session) => {
      prisma.authSession.findUnique.mockResolvedValue(session);

      await expect(makeService().findUsable(SESSION_ID)).resolves.toBeNull();
    });
  });

  describe('ligações em tempo real', () => {
    beforeEach(() => {
      live.closeSession.mockClear();
      live.closeUser.mockClear();
    });

    it('fecha os sockets da sessão que termina no logout', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeSession());

      await makeService().revokeByToken(tokenFor(CURRENT_SECRET));

      expect(live.closeSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('fecha os sockets de uma sessão revogada por reutilização do token', async () => {
      prisma.authSession.findUnique.mockResolvedValue(makeRotatedSession(31));

      await expect(
        makeService().rotate(tokenFor(PREVIOUS_SECRET)),
      ).rejects.toThrow();

      expect(live.closeSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('fecha os sockets de todas as sessões da conta, menos a de quem pediu', async () => {
      await makeService().revokeAllForUser(USER_ID, {
        exceptSessionId: SESSION_ID,
      });

      expect(live.closeUser).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    });
  });
});
