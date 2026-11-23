import {
  BadRequestException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { ErrorCode } from '../../../common/exceptions/error-codes';
import { PrismaService } from '../../../shared/db/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordConfirmationService } from './password-confirmation.service';
import { PasswordHasher } from './password-hasher.service';
import { SessionsService } from './sessions.service';
import { VerificationService } from './verification.service';

const USER_ID = 'user-uuid-001';
const SESSION_ID = 'session-uuid-001';
const PHONE = '+258840000001';
const EMAIL = 'test@zuno.co.mz';
const PASSWORD = 'gerador-amarelo';
const STORED_HASH = 'stored-hash';
const NEW_HASH = 'new-hash';
const ACCESS_TOKEN = 'access-token-mock';
const REFRESH_TOKEN = `${SESSION_ID}.refresh-secret`;
const ROTATED_REFRESH_TOKEN = `${SESSION_ID}.rotated-secret`;

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Daniel Zuno',
  phone: PHONE,
  email: EMAIL,
  passwordHash: STORED_HASH,
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

const makePrisma = () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  authSession: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
});

const makeSessions = () => ({
  open: jest.fn().mockResolvedValue({
    sessionId: SESSION_ID,
    userId: USER_ID,
    refreshToken: REFRESH_TOKEN,
  }),
  rotate: jest.fn().mockResolvedValue({
    sessionId: SESSION_ID,
    userId: USER_ID,
    refreshToken: ROTATED_REFRESH_TOKEN,
  }),
  revokeByToken: jest.fn().mockResolvedValue(undefined),
  revokeAllForUser: jest.fn().mockResolvedValue(0),
});

const makePasswords = () => ({
  hash: jest.fn().mockResolvedValue(NEW_HASH),
  matches: jest.fn().mockResolvedValue(true),
  needsRehash: jest.fn().mockReturnValue(false),
});

const makeLoginThrottle = () => ({
  assertNotLocked: jest.fn().mockResolvedValue(undefined),
  recordFailure: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined),
});

const makeVerification = () => ({
  issueCode: jest.fn(),
  consumeCode: jest.fn().mockResolvedValue(undefined),
});

const makePasswordConfirmation = () => ({
  confirm: jest.fn().mockResolvedValue({ phone: PHONE }),
});

const makeAudit = () => ({
  loginSucceeded: jest.fn().mockResolvedValue(undefined),
  loginFailed: jest.fn().mockResolvedValue(undefined),
  passwordChanged: jest.fn().mockResolvedValue(undefined),
  passwordReset: jest.fn().mockResolvedValue(undefined),
});

const ORIGIN = { ipAddress: '197.218.0.1', userAgent: 'ZunoApp/1.0' };

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrisma>;
  let sessions: ReturnType<typeof makeSessions>;
  let passwords: ReturnType<typeof makePasswords>;
  let loginThrottle: ReturnType<typeof makeLoginThrottle>;
  let verification: ReturnType<typeof makeVerification>;
  let passwordConfirmation: ReturnType<typeof makePasswordConfirmation>;
  let audit: ReturnType<typeof makeAudit>;
  let jwtService: { signAsync: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    sessions = makeSessions();
    passwords = makePasswords();
    loginThrottle = makeLoginThrottle();
    verification = makeVerification();
    passwordConfirmation = makePasswordConfirmation();
    audit = makeAudit();
    jwtService = { signAsync: jest.fn().mockResolvedValue(ACCESS_TOKEN) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: SessionsService, useValue: sessions },
        { provide: PasswordHasher, useValue: passwords },
        { provide: LoginThrottleService, useValue: loginThrottle },
        { provide: VerificationService, useValue: verification },
        {
          provide: PasswordConfirmationService,
          useValue: passwordConfirmation,
        },
        { provide: AuthAuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register()', () => {
    const dto = {
      name: 'Daniel Zuno',
      phone: PHONE,
      email: EMAIL,
      password: PASSWORD,
    };

    it('regista o utilizador com sucesso e devolve tokens + dados seguros', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // telefone livre
        .mockResolvedValueOnce(null); // email livre
      prisma.user.create.mockResolvedValue(makeUser());

      const result = await service.register(dto);

      expect(result.message).toBe('Conta criada com sucesso.');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.accessToken).toBe(ACCESS_TOKEN);
      expect(result.refreshToken).toBe(REFRESH_TOKEN);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });

    it('guarda o hash da password e nunca a password em texto simples', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());

      await service.register(dto);

      expect(passwords.hash).toHaveBeenCalledWith(PASSWORD);
      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.passwordHash).toBe(NEW_HASH);
      expect(createCall.data).not.toHaveProperty('password');
    });

    it('guarda o telefone tal como o DTO o normalizou', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());

      await service.register(dto);

      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.phone).toBe(PHONE);
    });

    it('normaliza o email para lowercase com trim()', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());

      await service.register({ ...dto, email: '  Test@Zuno.CO.MZ  ' });

      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.email).toBe('test@zuno.co.mz');
    });

    it('lança BadRequestException se o telefone já está em uso', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(sessions.open).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se o email já está em uso', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // telefone livre
        .mockResolvedValueOnce(makeUser()); // email ocupado

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('não verifica email duplicado se email não foi fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser({ email: null }));

      await service.register({
        name: 'Daniel',
        phone: PHONE,
        password: PASSWORD,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it.each(['840000001', '+258840000001', '258 84 000 0001'])(
      'recusa a password %p, que é o próprio telefone',
      async (password) => {
        await expect(service.register({ ...dto, password })).rejects.toThrow(
          'A password não pode ser o teu número de telefone.',
        );
        expect(prisma.user.create).not.toHaveBeenCalled();
      },
    );

    it('abre uma sessão para a conta nova, com a origem do pedido', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());
      const origin = { ipAddress: '197.218.0.1', userAgent: 'ZunoApp/1.0' };

      await service.register(dto, origin);

      expect(sessions.open).toHaveBeenCalledWith(USER_ID, origin);
    });

    it('o access token identifica o utilizador e a sessão', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(makeUser());

      await service.register(dto);

      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: USER_ID,
        sid: SESSION_ID,
        typ: 'access',
      });
    });
  });

  describe('login()', () => {
    const dto = { phone: PHONE, password: PASSWORD };

    /** Faz o login, que tem de falhar, e devolve o erro. */
    const loginError = async (): Promise<ApiException> => {
      try {
        await service.login(dto, ORIGIN);
      } catch (error) {
        return error as ApiException;
      }
      throw new Error('O login devia ter sido recusado.');
    };

    it('faz login com sucesso e devolve tokens + dados seguros', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      const result = await service.login(dto);

      expect(result.message).toBe('Login realizado com sucesso.');
      expect(result.accessToken).toBe(ACCESS_TOKEN);
      expect(result.refreshToken).toBe(REFRESH_TOKEN);
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(passwords.matches).toHaveBeenCalledWith(PASSWORD, STORED_HASH);
    });

    it('abre uma sessão nova e apaga as falhas anteriores do número', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      const origin = { ipAddress: '197.218.0.1', userAgent: 'ZunoApp/1.0' };

      await service.login(dto, origin);

      expect(sessions.open).toHaveBeenCalledWith(USER_ID, origin);
      expect(loginThrottle.clear).toHaveBeenCalledWith(PHONE);
      expect(loginThrottle.recordFailure).not.toHaveBeenCalled();
    });

    it('compara a password mesmo quando a conta não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      passwords.matches.mockResolvedValue(false);

      const error = await loginError();

      expect(passwords.matches).toHaveBeenCalledWith(PASSWORD, undefined);
      expect(error.getStatus()).toBe(401);
      expect(error.errorCode).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    });

    it('responde o mesmo com conta inexistente e com password errada', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      passwords.matches.mockResolvedValue(false);
      const unknownAccount = await loginError();

      prisma.user.findUnique.mockResolvedValueOnce(makeUser());
      const wrongPassword = await loginError();

      expect(unknownAccount.getResponse()).toEqual(wrongPassword.getResponse());
      expect(unknownAccount.message).toBe('Credenciais inválidas.');
      expect(sessions.open).not.toHaveBeenCalled();
    });

    it('conta uma falha para o número, exista ou não a conta', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      passwords.matches.mockResolvedValue(false);

      await loginError();

      expect(loginThrottle.recordFailure).toHaveBeenCalledWith(PHONE);
      expect(loginThrottle.clear).not.toHaveBeenCalled();
    });

    it('nem chega a ler a conta quando o número está bloqueado', async () => {
      loginThrottle.assertNotLocked.mockRejectedValue(
        new ApiException(
          ErrorCode.TOO_MANY_REQUESTS,
          'Demasiadas tentativas falhadas.',
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      const error = await loginError();

      expect(error.getStatus()).toBe(429);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(passwords.matches).not.toHaveBeenCalled();
    });

    it('diz que a conta está desactivada só a quem acertou na password', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      const rightPassword = await loginError();
      passwords.matches.mockResolvedValue(false);
      const wrongPassword = await loginError();

      expect(rightPassword.getStatus()).toBe(403);
      expect(rightPassword.message).toBe('Conta desativada.');
      expect(wrongPassword.getStatus()).toBe(401);
      expect(sessions.open).not.toHaveBeenCalled();
    });

    it('regista em auditoria a entrada, com a sessão e a origem', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.login(dto, ORIGIN);

      expect(audit.loginSucceeded).toHaveBeenCalledWith(
        USER_ID,
        SESSION_ID,
        ORIGIN,
      );
      expect(audit.loginFailed).not.toHaveBeenCalled();
    });

    it('regista em auditoria a password errada numa conta que existe', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      passwords.matches.mockResolvedValue(false);

      await loginError();

      expect(audit.loginFailed).toHaveBeenCalledWith(
        USER_ID,
        'WRONG_PASSWORD',
        ORIGIN,
      );
      expect(audit.loginSucceeded).not.toHaveBeenCalled();
    });

    it('não regista nada quando o número não tem conta', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      passwords.matches.mockResolvedValue(false);

      await loginError();

      expect(audit.loginFailed).not.toHaveBeenCalled();
    });

    it('regista em auditoria a tentativa de entrar numa conta suspensa', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await loginError();

      expect(audit.loginFailed).toHaveBeenCalledWith(
        USER_ID,
        'ACCOUNT_SUSPENDED',
        ORIGIN,
      );
    });

    it('refaz o hash guardado com um custo mais baixo do que o actual', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      passwords.needsRehash.mockReturnValue(true);

      await service.login(dto);

      expect(passwords.needsRehash).toHaveBeenCalledWith(STORED_HASH);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { passwordHash: NEW_HASH },
      });
    });

    it('não mexe no hash que já tem o custo actual', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.login(dto);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('refreshToken()', () => {
    it('troca o refresh token e assina um access token para a mesma sessão', async () => {
      const result = await service.refreshToken(REFRESH_TOKEN);

      expect(sessions.rotate).toHaveBeenCalledWith(REFRESH_TOKEN);
      expect(result).toEqual({
        message: 'Token renovado com sucesso.',
        accessToken: ACCESS_TOKEN,
        refreshToken: ROTATED_REFRESH_TOKEN,
      });
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: USER_ID,
        sid: SESSION_ID,
        typ: 'access',
      });
    });

    it('não assina access token quando a sessão recusa o refresh token', async () => {
      sessions.rotate.mockRejectedValue(
        new UnauthorizedException('Sessão inválida ou revogada.'),
      );

      await expect(service.refreshToken(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });
  });

  describe('logout()', () => {
    it('termina a sessão do refresh token apresentado', async () => {
      const result = await service.logout(REFRESH_TOKEN);

      expect(result.message).toBe('Logout realizado com sucesso.');
      expect(sessions.revokeByToken).toHaveBeenCalledWith(REFRESH_TOKEN);
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('lança UnauthorizedException se a sessão não existe ou já foi revogada', async () => {
      sessions.revokeByToken.mockRejectedValue(
        new UnauthorizedException('Sessão inválida ou já revogada.'),
      );

      await expect(service.logout(REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('changePassword()', () => {
    const dto = { currentPassword: PASSWORD, newPassword: 'betoneira-azul' };

    it('confirma a password actual, guarda o hash da nova e termina as outras sessões', async () => {
      const result = await service.changePassword(USER_ID, SESSION_ID, dto);

      expect(result.message).toBe('Password alterada com sucesso.');
      expect(passwordConfirmation.confirm).toHaveBeenCalledWith(
        USER_ID,
        PASSWORD,
        'PASSWORD_CHANGE',
      );
      expect(passwords.hash).toHaveBeenCalledWith(dto.newPassword);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { passwordHash: NEW_HASH },
      });
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID, {
        exceptSessionId: SESSION_ID,
      });
      expect(audit.passwordChanged).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    });

    it('recusa quando a password actual está errada, sem mexer nas sessões', async () => {
      passwordConfirmation.confirm.mockRejectedValue(
        new ApiException(
          ErrorCode.AUTH_WRONG_CURRENT_PASSWORD,
          'Password actual incorrecta.',
          HttpStatus.BAD_REQUEST,
        ),
      );

      await expect(
        service.changePassword(USER_ID, SESSION_ID, dto),
      ).rejects.toThrow('Password actual incorrecta.');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(audit.passwordChanged).not.toHaveBeenCalled();
    });

    it('recusa o próprio telefone como password nova', async () => {
      await expect(
        service.changePassword(USER_ID, SESSION_ID, {
          ...dto,
          newPassword: '840000001',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword()', () => {
    const dto = { phone: PHONE, code: '123456', newPassword: 'betoneira-azul' };

    it('gasta o código e guarda o hash da password nova', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.resetPassword(dto);

      expect(verification.consumeCode).toHaveBeenCalledWith({
        userId: USER_ID,
        code: dto.code,
        purpose: 'PASSWORD_RESET',
      });
      expect(passwords.hash).toHaveBeenCalledWith(dto.newPassword);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('entrega a conta limpa do número de recebimento e do token de push que lá estivessem', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.resetPassword(dto);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: expect.objectContaining({
          payoutMsisdn: null,
          pushToken: null,
        }) as object,
      });
    });

    it('regista em auditoria a redefinição, com a origem do pedido', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.resetPassword(dto, ORIGIN);

      expect(audit.passwordReset).toHaveBeenCalledWith(USER_ID, ORIGIN);
    });

    it('não regista a redefinição quando o código é recusado', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      verification.consumeCode.mockRejectedValue(
        new BadRequestException('Código inválido ou expirado.'),
      );

      await expect(service.resetPassword(dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(audit.passwordReset).not.toHaveBeenCalled();
    });

    it('recusa o próprio telefone como password sem gastar o código', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(
        service.resetPassword({ ...dto, newPassword: '840000001' }),
      ).rejects.toThrow(BadRequestException);
      expect(verification.consumeCode).not.toHaveBeenCalled();
    });

    it('responde como a um código errado quando a conta não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Código inválido ou expirado.',
      );
      expect(verification.consumeCode).not.toHaveBeenCalled();
    });
  });

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
