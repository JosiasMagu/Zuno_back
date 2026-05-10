import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, UserRole } from '@prisma/client';

import { ChatService } from './chat.service';
import { PrismaService } from '../../../shared/db/prisma.service';

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const CONVERSATION_ID = 'conversation-uuid-001';
const MESSAGE_ID = 'message-uuid-001';

const makeUser = (id: string, role: UserRole) => ({ id, role });

const makeEquipment = (overrides: Record<string, unknown> = {}) => ({
  id: EQUIPMENT_ID,
  ownerId: OWNER_ID,
  status: EquipmentStatus.ACTIVE,
  title: 'Escavadora Caterpillar 320D',
  ...overrides,
});

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  id: CONVERSATION_ID,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  equipmentId: EQUIPMENT_ID,
  lastMessage: null,
  lastMessageAt: null,
  createdAt: new Date(),
  client: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  owner: { id: OWNER_ID, name: 'Proprietario', avatarUrl: null },
  equipment: {
    id: EQUIPMENT_ID,
    title: 'Escavadora Caterpillar 320D',
    photos: [{ url: 'https://cdn.example.com/photo.jpg' }],
  },
  ...overrides,
});

const makeMessage = (overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: CLIENT_ID,
  content: 'Ola, ainda esta disponivel?',
  isRead: false,
  createdAt: new Date(),
  sender: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  ...overrides,
});

const makePrismaMock = () => ({
  user: { findUnique: jest.fn() },
  equipment: { findUnique: jest.fn() },
  conversation: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  message: {
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
});

describe('ChatService', () => {
  let service: ChatService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('startConversation()', () => {
    const validDto = {
      equipmentId: EQUIPMENT_ID,
      firstMessage: 'Ola, ainda esta disponivel?',
    };

    it('lanca NotFoundException se utilizador nao existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.startConversation(CLIENT_ID, validDto),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('lanca ForbiddenException se quem inicia nao e CLIENT', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );

      await expect(
        service.startConversation(OWNER_ID, validDto),
      ).rejects.toThrow(
        new ForbiddenException('Só clientes podem iniciar conversas.'),
      );
    });

    it('lanca NotFoundException se equipment nao existe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.startConversation(CLIENT_ID, validDto),
      ).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado ou indisponível.'),
      );
    });

    it('lanca NotFoundException se equipment nao esta ACTIVE', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ status: EquipmentStatus.PENDING_REVIEW }),
      );

      await expect(
        service.startConversation(CLIENT_ID, validDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejeita se cliente e dono do proprio equipamento', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ ownerId: OWNER_ID }),
      );

      await expect(
        service.startConversation(OWNER_ID, validDto),
      ).rejects.toThrow(
        new BadRequestException(
          'Não podes iniciar uma conversa sobre o teu próprio equipamento.',
        ),
      );
    });

    it('reutiliza conversa existente em vez de criar duplicado', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(makeConversation());
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.conversation.update.mockResolvedValue({});
      prisma.$transaction.mockResolvedValue([makeMessage(), {}]);

      const result = await service.startConversation(CLIENT_ID, validDto);

      expect(result.data.isNew).toBe(false);
      expect(result.message).toBe('Mensagem enviada na conversa existente.');
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('cria nova conversa quando nao existe e devolve isNew=true', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.conversation.create.mockResolvedValue(makeConversation());
          prisma.message.create.mockResolvedValue(makeMessage());
          return cb(prisma);
        },
      );

      const result = await service.startConversation(CLIENT_ID, validDto);

      expect(result.data.isNew).toBe(true);
      expect(result.message).toBe('Conversa iniciada com sucesso.');
      expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
    });

    it('procura conversa pela tripla (clientId, ownerId, equipmentId)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.conversation.create.mockResolvedValue(makeConversation());
          prisma.message.create.mockResolvedValue(makeMessage());
          return cb(prisma);
        },
      );

      await service.startConversation(CLIENT_ID, validDto);

      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: CLIENT_ID,
            ownerId: OWNER_ID,
            equipmentId: EQUIPMENT_ID,
          },
        }),
      );
    });
  });

  describe('findMyConversations()', () => {
    it('devolve conversas onde o utilizador e CLIENT ou OWNER, ordenadas por lastMessageAt desc', async () => {
      prisma.conversation.findMany.mockResolvedValue([makeConversation()]);

      const result = await service.findMyConversations(CLIENT_ID);

      expect(result.message).toBe('Conversas obtidas com sucesso.');
      expect(result.data).toHaveLength(1);
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ clientId: CLIENT_ID }, { ownerId: CLIENT_ID }] },
          orderBy: { lastMessageAt: 'desc' },
        }),
      );
    });

    it('devolve lista vazia quando nao ha conversas', async () => {
      prisma.conversation.findMany.mockResolvedValue([]);

      const result = await service.findMyConversations(CLIENT_ID);

      expect(result.data).toEqual([]);
    });
  });

  describe('findConversation()', () => {
    const query = { page: 1, limit: 30 };

    it('lanca NotFoundException se conversa nao existe', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.findConversation(CLIENT_ID, CONVERSATION_ID, query),
      ).rejects.toThrow(new NotFoundException('Conversa não encontrada.'));
    });

    it('lanca ForbiddenException se utilizador nao e participante', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());

      await expect(
        service.findConversation(STRANGER_ID, CONVERSATION_ID, query),
      ).rejects.toThrow(
        new ForbiddenException('Não tens acesso a esta conversa.'),
      );
    });

    it('CLIENT participante recebe mensagens e marca como lidas as do interlocutor', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([
        makeMessage({ senderId: OWNER_ID, isRead: false }),
      ]);
      prisma.message.count.mockResolvedValue(1);
      prisma.message.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.findConversation(
        CLIENT_ID,
        CONVERSATION_ID,
        query,
      );

      expect(result.data.messages).toHaveLength(1);
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: {
          conversationId: CONVERSATION_ID,
          senderId: { not: CLIENT_ID },
          isRead: false,
        },
        data: { isRead: true },
      });
    });

    it('OWNER participante tambem tem acesso', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.findConversation(
        OWNER_ID,
        CONVERSATION_ID,
        query,
      );

      expect(result.message).toBe('Conversa obtida com sucesso.');
    });

    it('devolve meta de paginacao correcta', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([makeMessage()]);
      prisma.message.count.mockResolvedValue(75);
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.findConversation(
        CLIENT_ID,
        CONVERSATION_ID,
        {
          page: 2,
          limit: 30,
        },
      );

      expect(result.data.meta).toMatchObject({
        page: 2,
        limit: 30,
        total: 75,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('aplica defaults page=1 limit=30 quando query nao define', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      await service.findConversation(CLIENT_ID, CONVERSATION_ID, {});

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 30 }),
      );
    });
  });

  describe('sendMessageToConversation()', () => {
    it('rejeita conteudo vazio', async () => {
      await expect(
        service.sendMessageToConversation(CLIENT_ID, CONVERSATION_ID, '   '),
      ).rejects.toThrow(
        new BadRequestException(
          'Mensagem inválida. Deve ter entre 1 e 1000 caracteres.',
        ),
      );
    });

    it('rejeita conteudo com mais de 1000 caracteres', async () => {
      const tooLong = 'a'.repeat(1001);

      await expect(
        service.sendMessageToConversation(CLIENT_ID, CONVERSATION_ID, tooLong),
      ).rejects.toThrow(BadRequestException);
    });

    it('lanca NotFoundException se conversa nao existe', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.sendMessageToConversation(CLIENT_ID, CONVERSATION_ID, 'ola'),
      ).rejects.toThrow(new NotFoundException('Conversa não encontrada.'));
    });

    it('lanca ForbiddenException se sender nao e participante', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      });

      await expect(
        service.sendMessageToConversation(STRANGER_ID, CONVERSATION_ID, 'ola'),
      ).rejects.toThrow(
        new ForbiddenException('Não tens acesso a esta conversa.'),
      );
    });

    it('faz trim, persiste mensagem e actualiza lastMessage da conversa em transacao', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.$transaction.mockResolvedValue([
        makeMessage({ content: 'ola mundo' }),
        {},
      ]);

      const result = await service.sendMessageToConversation(
        CLIENT_ID,
        CONVERSATION_ID,
        '  ola mundo  ',
      );

      expect(result).toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(ops).toHaveLength(2);
    });

    it('OWNER tambem pode enviar mensagem', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.$transaction.mockResolvedValue([makeMessage(), {}]);

      await expect(
        service.sendMessageToConversation(OWNER_ID, CONVERSATION_ID, 'sim'),
      ).resolves.toBeDefined();
    });
  });

  describe('countUnread()', () => {
    it('conta mensagens nao lidas em conversas onde o utilizador participa', async () => {
      prisma.message.count.mockResolvedValue(7);

      const result = await service.countUnread(CLIENT_ID);

      expect(result.data.unreadCount).toBe(7);
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: {
          conversation: {
            OR: [{ clientId: CLIENT_ID }, { ownerId: CLIENT_ID }],
          },
          senderId: { not: CLIENT_ID },
          isRead: false,
        },
      });
    });

    it('devolve zero quando nao ha mensagens por ler', async () => {
      prisma.message.count.mockResolvedValue(0);

      const result = await service.countUnread(CLIENT_ID);

      expect(result.data.unreadCount).toBe(0);
    });
  });
});
