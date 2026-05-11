import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { UsersService } from './users.service';

const USER_ID = 'user-uuid-001';
const OTHER_USER_ID = 'user-uuid-002';
const PHONE = '+258840000001';
const EMAIL = 'zuno@zuno.co.mz';

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Zuno',
  phone: PHONE,
  email: EMAIL,
  passwordHash: 'hashed-value',
  role: UserRole.CLIENT,
  isVerified: true,
  isActive: true,
  avatarUrl: null,
  bio: null,
  totalRating: null,
  totalReviews: 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const makePublicUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Zuno',
  avatarUrl: null,
  bio: null,
  role: UserRole.CLIENT,
  isActive: true,
  totalRating: null,
  totalReviews: 0,
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

const makePrisma = () => ({
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
});

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getMe()', () => {
    it('devolve o perfil do utilizador com mensagem de sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      const result = await service.getMe(USER_ID);

      expect(result.message).toBe('Perfil obtido com sucesso.');
      expect(result.data).toHaveProperty('id', USER_ID);
      expect(result.data).toHaveProperty('phone', PHONE);
    });

    it('não expõe passwordHash na resposta', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      const result = await service.getMe(USER_ID);

      expect(result.data).not.toHaveProperty('passwordHash');
    });

    it('devolve totalRating como null quando não há avaliações', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ totalRating: null }));

      const result = await service.getMe(USER_ID);

      expect(result.data.totalRating).toBeNull();
    });

    it('devolve totalRating como número quando existe', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ totalRating: 4.5 }));

      const result = await service.getMe(USER_ID);

      expect(result.data.totalRating).toBe(4.5);
    });

    it('devolve totalReviews como 0 quando não há avaliações', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ totalReviews: 0 }));

      const result = await service.getMe(USER_ID);

      expect(result.data.totalReviews).toBe(0);
    });

    it('lança UnauthorizedException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getMe(USER_ID)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a mensagem da excepção indica que o utilizador não foi encontrado', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const error = await service.getMe(USER_ID).catch((e) => e);
      expect(error.message).toBe('Utilizador não encontrado.');
    });

    it('lança UnauthorizedException se a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await expect(service.getMe(USER_ID)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a mensagem da excepção indica que a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      const error = await service.getMe(USER_ID).catch((e) => e);
      expect(error.message).toBe('Conta desativada.');
    });

    it('procura o utilizador pelo userId fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.getMe(USER_ID);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
      });
    });
  });

  describe('updateMe()', () => {
    it('actualiza o nome com sucesso e devolve o perfil actualizado', async () => {
      const updated = makeUser({ name: 'Daniel Actualizado' });
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(updated);

      const result = await service.updateMe(USER_ID, {
        name: 'Daniel Actualizado',
      });

      expect(result.message).toBe('Perfil atualizado com sucesso.');
      expect(result.data.name).toBe('Daniel Actualizado');
    });

    it('faz trim() ao nome antes de guardar', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ name: 'Daniel' }));

      await service.updateMe(USER_ID, { name: '  Daniel  ' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.name).toBe('Daniel');
    });

    it('actualiza o bio com sucesso', async () => {
      const bio = 'Engenheiro de software em Maputo.';
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ bio }));

      await service.updateMe(USER_ID, { bio });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.bio).toBe(bio);
    });

    it('guarda bio como null quando string vazia é fornecida', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ bio: null }));

      await service.updateMe(USER_ID, { bio: '   ' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.bio).toBeNull();
    });

    it('actualiza avatarUrl com sucesso', async () => {
      const url = 'https://cdn.zuno.co.mz/avatar.jpg';
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ avatarUrl: url }));

      await service.updateMe(USER_ID, { avatarUrl: url });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.avatarUrl).toBe(url);
    });

    it('guarda avatarUrl como null quando string vazia é fornecida', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ avatarUrl: null }));

      await service.updateMe(USER_ID, { avatarUrl: '   ' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.avatarUrl).toBeNull();
    });

    it('actualiza o email para lowercase com trim()', async () => {
      const normalizedEmail = 'novo@zuno.co.mz';
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser()) // utilizador actual
        .mockResolvedValueOnce(null); // verificação de email duplicado
      prisma.user.update.mockResolvedValue(
        makeUser({ email: normalizedEmail }),
      );

      await service.updateMe(USER_ID, { email: '  Novo@Zuno.CO.MZ  ' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.email).toBe(normalizedEmail);
    });

    it('guarda email como null quando string vazia é fornecida', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser({ email: null }));

      await service.updateMe(USER_ID, { email: '   ' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.email).toBeNull();
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('não verifica duplicado se o email fornecido é o mesmo do utilizador actual', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ email: EMAIL }));
      prisma.user.update.mockResolvedValue(makeUser());

      await service.updateMe(USER_ID, { email: EMAIL });

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('lança BadRequestException se o novo email já pertence a outro utilizador', async () => {
      const outroUtilizador = makeUser({
        id: OTHER_USER_ID,
        email: 'novo@zuno.co.mz',
      });

      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser()) // utilizador actual
        .mockResolvedValueOnce(outroUtilizador); // email ocupado por outro

      await expect(
        service.updateMe(USER_ID, { email: 'novo@zuno.co.mz' }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('a mensagem da excepção de email duplicado é clara', async () => {
      const outroUtilizador = makeUser({
        id: OTHER_USER_ID,
        email: 'novo@zuno.co.mz',
      });

      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(outroUtilizador);

      const error = await service
        .updateMe(USER_ID, { email: 'novo@zuno.co.mz' })
        .catch((e) => e);
      expect(error.message).toBe('Este email já está em uso.');
    });

    it('permite actualizar email para um email que pertencia ao próprio utilizador (mesmo id)', async () => {
      // Cenario: o findUnique de verificacao devolve o proprio utilizador - e permitido
      const proprio = makeUser({ email: 'novo@zuno.co.mz' });

      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser()) // utilizador actual
        .mockResolvedValueOnce(proprio); // verificação: é o próprio

      prisma.user.update.mockResolvedValue(
        makeUser({ email: 'novo@zuno.co.mz' }),
      );

      const result = await service.updateMe(USER_ID, {
        email: 'novo@zuno.co.mz',
      });

      expect(result.message).toBe('Perfil atualizado com sucesso.');
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('não inclui campos no data do update quando não foram fornecidos no dto', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser());

      // Passar apenas name - bio, email, avatarUrl nao devem aparecer no data
      await service.updateMe(USER_ID, { name: 'Novo Nome' });

      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('bio');
      expect(updateCall.data).not.toHaveProperty('email');
      expect(updateCall.data).not.toHaveProperty('avatarUrl');
    });

    it('lança UnauthorizedException se o utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateMe(USER_ID, { name: 'Novo Nome' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('lança UnauthorizedException se a conta está desactivada', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

      await expect(
        service.updateMe(USER_ID, { name: 'Novo Nome' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('não expõe passwordHash na resposta do update', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      prisma.user.update.mockResolvedValue(makeUser());

      const result = await service.updateMe(USER_ID, { name: 'ZUNO1' });

      expect(result.data).not.toHaveProperty('passwordHash');
    });
  });

  describe('getPublicProfile()', () => {
    it('devolve o perfil público com mensagem de sucesso', async () => {
      prisma.user.findUnique.mockResolvedValue(makePublicUser());

      const result = await service.getPublicProfile(USER_ID);

      expect(result.message).toBe('Perfil público obtido com sucesso.');
      expect(result.data).toHaveProperty('id', USER_ID);
      expect(result.data).toHaveProperty('name', 'Zuno');
    });

    it('não expõe phone nem passwordHash no perfil público', async () => {
      prisma.user.findUnique.mockResolvedValue(makePublicUser());

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data).not.toHaveProperty('phone');
      expect(result.data).not.toHaveProperty('passwordHash');
      expect(result.data).not.toHaveProperty('email');
    });

    it('expõe bio quando preenchido', async () => {
      const bio = 'Proprietário de equipamentos em Maputo.';
      prisma.user.findUnique.mockResolvedValue(makePublicUser({ bio }));

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.bio).toBe(bio);
    });

    it('expõe bio como null quando não preenchido', async () => {
      prisma.user.findUnique.mockResolvedValue(makePublicUser({ bio: null }));

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.bio).toBeNull();
    });

    it('expõe totalRating como número quando existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ totalRating: 4.8 }),
      );

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.totalRating).toBe(4.8);
    });

    it('expõe totalRating como null quando não há avaliações', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ totalRating: null }),
      );

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.totalRating).toBeNull();
    });

    it('expõe totalReviews como 0 quando não há avaliações', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ totalReviews: 0 }),
      );

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.totalReviews).toBe(0);
    });

    it('lança NotFoundException se o utilizador não existe (findUnique devolve null)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getPublicProfile(USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança NotFoundException se a conta está desactivada — mesmo que o utilizador exista', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ isActive: false }),
      );

      await expect(service.getPublicProfile(USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('a mensagem de erro é a mesma para utilizador inexistente e inactivo — não revela estado', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const errorInexistente = await service
        .getPublicProfile(USER_ID)
        .catch((e) => e);

      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ isActive: false }),
      );
      const errorInactivo = await service
        .getPublicProfile(USER_ID)
        .catch((e) => e);

      expect(errorInexistente.message).toBe('Utilizador não encontrado.');
      expect(errorInactivo.message).toBe(errorInexistente.message);
    });

    it('procura o utilizador com select explícito — não carrega passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue(makePublicUser());

      await service.getPublicProfile(USER_ID);
      const call = prisma.user.findUnique.mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.select).not.toHaveProperty('passwordHash');
    });

    it('expõe avatarUrl quando preenchido', async () => {
      const url = 'https://cdn.zuno.co.mz/avatar.jpg';
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ avatarUrl: url }),
      );

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.avatarUrl).toBe(url);
    });

    it('expõe avatarUrl como null quando não preenchido', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makePublicUser({ avatarUrl: null }),
      );

      const result = await service.getPublicProfile(USER_ID);

      expect(result.data.avatarUrl).toBeNull();
    });
  });
});
