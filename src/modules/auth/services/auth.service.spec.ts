import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../../shared/db/prisma.service';
import { AuthService } from './auth.service';
import { VerificationService } from './verification.service';

const verificationMock = {
  issueCode: jest.fn(),
  consumeCode: jest.fn(),
};

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-value'),
  compare: jest.fn().mockResolvedValue(true),
}));

const USER_ID = 'user-uuid-001';
const SESSION_ID = 'session-uuid-001';
const PHONE = '+258840000001';
const EMAIL = 'test@zuno.co.mz';
const PASSWORD = 'Senha@123';
const ACCESS_TOKEN = 'access-token-mock';
const REFRESH_TOKEN = 'refresh-token-mock';

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Daniel Zuno',
  phone: PHONE,
  email: EMAIL,
  passwordHash: 'hashed-value',
  role: UserRole.CLIENT,
  isVerified: false,
  isActive: true,
  avatarUrl: null,
  bio: null,
  totalRating: null,
  totalReviews: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  userId: USER_ID,
  refreshTokenHash: 'hashed-value',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 dias no futuro
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makePrisma = () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  authSession: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrisma>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue(ACCESS_TOKEN),
            verifyAsync: jest.fn().mockResolvedValue({
              sub: USER_ID,
              phone: PHONE,
              role: UserRole.CLIENT,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-secret-value'),
            get: jest.fn().mockReturnValue(undefined),
          },
        },
        { provide: VerificationService, useValue: verificationMock },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
    configService = module.get(ConfigService);

    expect(configService).toBeDefined();
  });

  afterEach(() => jest.clearAllMocks());

  // register()

  describe('register()', () => {
    const dto = {
      name: 'Daniel Zuno',
      phone: PHONE,
      email: EMAIL,
      password: PASSWORD,
    };

    it('regista o utilizador com sucesso e devolve tokens + dados seguros', async () => {
      prisma.user.findUnique.mockResolvedValue(null); // phone livre
      // segundo findUnique = verificacao de email (tambem livre)
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      const result = await service.register(dto);

      expect(result.message).toBe('Conta criada com sucesso.');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.accessToken).toBeDefined();
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    });

    it('faz hash da password antes de guardar — nunca guarda em texto simples', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      await service.register(dto);

      expect(bcrypt.hash).toHaveBeenCalledWith(PASSWORD, 10);
      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.passwordHash).toBe('hashed-value');
      expect(createCall.data).not.toHaveProperty('password');
    });

    it('normaliza o telefone com trim()', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      await service.register({ ...dto, phone: `  ${PHONE}  ` });

      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.phone).toBe(PHONE);
    });

    it('normaliza o email para lowercase com trim()', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      await service.register({ ...dto, email: '  Test@Zuno.CO.MZ  ' });

      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.email).toBe('test@zuno.co.mz');
    });

    it('lança BadRequestException se o telefone já está em uso', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se o email já está em uso', async () => {
      // primeiro findUnique (telefone) = livre, segundo (email) = ocupado
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeUser());

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('não verifica email duplicado se email não foi fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser({ email: null }));
      prisma.authSession.create.mockResolvedValue(makeSession());

      await service.register({
        name: 'Daniel',
        phone: PHONE,
        password: PASSWORD,
      });

      // findUnique chamado apenas 1 vez (telefone) - nao verifica email
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('cria sessão com o refreshToken em hash — nunca em texto simples', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      // JwtService devolve tokens diferentes por chamada
      jwtService.signAsync
        .mockResolvedValueOnce(ACCESS_TOKEN)
        .mockResolvedValueOnce(REFRESH_TOKEN);

      await service.register(dto);

      expect(bcrypt.hash).toHaveBeenCalledWith(REFRESH_TOKEN, 10);
      const sessionCall = prisma.authSession.create.mock.calls[0][0];
      expect(sessionCall.data.refreshTokenHash).toBe('hashed-value');
    });

    it('a sessão criada expira em ~7 dias', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      await service.register(dto);

      const sessionCall = prisma.authSession.create.mock.calls[0][0];
      const expiresAt: Date = sessionCall.data.expiresAt;
      const diffDays =
        (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThan(8);
    });

    it('o utilizador retornado não expõe passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());

      const result = await service.register(dto);

      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user).toHaveProperty('id');
      expect(result.user).toHaveProperty('role');
    });
  });

  // login()

  describe('login()', () => {
    const dto = { phone: PHONE, password: PASSWORD };

    it('faz login com sucesso e devolve tokens + dados seguros', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login(dto);

      expect(result.message).toBe('Login realizado com sucesso.');
      expect(result.accessToken).toBeDefined();
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('lança UnauthorizedException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('lança UnauthorizedException se a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('lança UnauthorizedException se a password está errada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('a mensagem de erro é genérica — não revela se o utilizador existe ou não', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const error = await service.login(dto).catch((e) => e);
      expect(error.message).toBe('Credenciais inválidas.');
    });

    it('a mensagem de erro é a mesma para password errada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const error = await service.login(dto).catch((e) => e);
      expect(error.message).toBe('Credenciais inválidas.');
    });

    it('compara a password com o hash guardado na base de dados', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.authSession.create.mockResolvedValue(makeSession());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login(dto);

      expect(bcrypt.compare).toHaveBeenCalledWith(PASSWORD, user.passwordHash);
    });

    it('cria nova sessão após login bem sucedido', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.create.mockResolvedValue(makeSession());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login(dto);

      expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    });
  });

  // refreshToken()

  describe('refreshToken()', () => {
    it('renova o token com sucesso e actualiza a sessão', async () => {
      const session = makeSession();
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.findMany.mockResolvedValue([session]);
      prisma.authSession.update.mockResolvedValue(session);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.refreshToken(REFRESH_TOKEN);

      expect(result.message).toBe('Token renovado com sucesso.');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(prisma.authSession.update).toHaveBeenCalledTimes(1);
    });

    it('guarda o novo refreshToken como hash na sessão actualizada', async () => {
      const session = makeSession();
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.findMany.mockResolvedValue([session]);
      prisma.authSession.update.mockResolvedValue(session);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      jwtService.signAsync
        .mockResolvedValueOnce(ACCESS_TOKEN)
        .mockResolvedValueOnce('new-refresh-token');

      await service.refreshToken(REFRESH_TOKEN);

      expect(bcrypt.hash).toHaveBeenCalledWith('new-refresh-token', 10);
      const updateCall = prisma.authSession.update.mock.calls[0][0];
      expect(updateCall.data.refreshTokenHash).toBe('hashed-value');
    });

    it('lança UnauthorizedException se token está vazio', async () => {
      await expect(service.refreshToken('')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshToken('   ')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se JWT é inválido', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('invalid token'));

      await expect(service.refreshToken('token-invalido')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se não existe sessão activa correspondente', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.findMany.mockResolvedValue([makeSession()]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false); // nenhum hash corresponde

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException e revoga a sessão se o token expirou', async () => {
      const expiredSession = makeSession({
        expiresAt: new Date(Date.now() - 1000), // expirou há 1 segundo
      });
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.findMany.mockResolvedValue([expiredSession]);
      prisma.authSession.update.mockResolvedValue(expiredSession);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );

      // A sessao expirada deve ser revogada
      expect(prisma.authSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: expiredSession.id },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('não encontra sessões revogadas — filtra revokedAt: null', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.authSession.findMany.mockResolvedValue([]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );

      const findManyCall = prisma.authSession.findMany.mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        userId: USER_ID,
        revokedAt: null,
      });
    });
  });

  // logout()

  describe('logout()', () => {
    it('faz logout com sucesso e revoga a sessão correcta', async () => {
      const session = makeSession();
      prisma.authSession.findMany.mockResolvedValue([session]);
      prisma.authSession.update.mockResolvedValue(session);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.logout(REFRESH_TOKEN);

      expect(result.message).toBe('Logout realizado com sucesso.');
      expect(prisma.authSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: session.id },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('lança UnauthorizedException se token está vazio', async () => {
      await expect(service.logout('')).rejects.toThrow(UnauthorizedException);
      await expect(service.logout('   ')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se JWT é inválido', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('invalid'));

      await expect(service.logout('token-invalido')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se a sessão não existe ou já foi revogada', async () => {
      prisma.authSession.findMany.mockResolvedValue([makeSession()]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false); // nenhum hash corresponde

      await expect(service.logout(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.authSession.update).not.toHaveBeenCalled();
    });

    it('revoga apenas a sessão do dispositivo actual — não todas as sessões', async () => {
      const targetSession = makeSession({ id: 'session-A' });
      const otherSession = makeSession({ id: 'session-B' });

      prisma.authSession.findMany.mockResolvedValue([
        targetSession,
        otherSession,
      ]);
      prisma.authSession.update.mockResolvedValue(targetSession);

      // bcrypt.compare retorna true apenas para a primeira sessao
      (bcrypt.compare as jest.Mock)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await service.logout(REFRESH_TOKEN);

      expect(prisma.authSession.update).toHaveBeenCalledTimes(1);
      expect(prisma.authSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'session-A' } }),
      );
    });
  });

  // getMe()

  describe('getMe()', () => {
    it('devolve os dados do utilizador sem passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      const result = await service.getMe(USER_ID);

      expect(result).toHaveProperty('id', USER_ID);
      expect(result).toHaveProperty('phone', PHONE);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('lança UnauthorizedException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getMe(USER_ID)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lança UnauthorizedException se a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await expect(service.getMe(USER_ID)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
