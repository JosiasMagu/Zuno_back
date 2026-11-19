import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma, UserRole } from '@prisma/client';

import { ChatRateLimiter, tooManyRequests } from '../chat-rate-limit';
import { ChatService } from './chat.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';

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
  owner: { isActive: true },
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
  service: { findUnique: jest.fn() },
  booking: { findFirst: jest.fn() },
  serviceRequest: { findFirst: jest.fn() },
  conversation: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    // Por omissão a conta ainda não abriu conversas hoje.
    count: jest.fn().mockResolvedValue(0),
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

const pushMock = { send: jest.fn().mockResolvedValue(undefined) };
// Por omissão nenhuma conta passou o limite de mensagens.
const limiterMock = { assertMayPost: jest.fn() };

describe('ChatService', () => {
  let service: ChatService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: pushMock },
        { provide: ChatRateLimiter, useValue: limiterMock },
      ],
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

    it('permite que um PROVIDER inicie conversa (regra so-CLIENT foi removida)', async () => {
      // Qualquer utilizador pode reservar equipamento de outro, logo pode
      // iniciar conversa; o fluxo prossegue ate a validacao do equipamento.
      prisma.user.findUnique.mockResolvedValue(
        makeUser(OWNER_ID, UserRole.PROVIDER),
      );
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.startConversation(OWNER_ID, validDto),
      ).rejects.toThrow('Equipamento não encontrado ou indisponível.');
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
            serviceId: null,
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

    it('CLIENT participante recebe mensagens e marca como lidas as do interlocutor até à mais recente entregue', async () => {
      const newest = new Date('2026-11-17T10:00:00.000Z');
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([
        makeMessage({ senderId: OWNER_ID, isRead: false, createdAt: newest }),
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
          createdAt: { lte: newest },
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

  // Limites, o dono do anúncio a escrever e as corridas

  describe('limites', () => {
    const asParticipant = () =>
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      });

    it('passa cada mensagem pelo limite por minuto da conta', async () => {
      asParticipant();
      prisma.$transaction.mockResolvedValue([makeMessage(), {}]);

      await service.sendMessageToConversation(
        CLIENT_ID,
        CONVERSATION_ID,
        'ola',
      );

      expect(limiterMock.assertMayPost).toHaveBeenCalledWith(CLIENT_ID);
    });

    it('não grava a mensagem de quem passou o limite', async () => {
      asParticipant();
      limiterMock.assertMayPost.mockImplementationOnce(() => {
        throw tooManyRequests('Estás a enviar mensagens depressa de mais.');
      });

      await expect(
        service.sendMessageToConversation(CLIENT_ID, CONVERSATION_ID, 'ola'),
      ).rejects.toThrow(HttpException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('não conta para o limite uma mensagem de quem está fora da conversa', async () => {
      asParticipant();

      await expect(
        service.sendMessageToConversation(STRANGER_ID, CONVERSATION_ID, 'ola'),
      ).rejects.toThrow(ForbiddenException);
      expect(limiterMock.assertMayPost).not.toHaveBeenCalled();
    });

    it('recusa um conteúdo que não é texto', async () => {
      await expect(
        service.sendMessageToConversation(
          CLIENT_ID,
          CONVERSATION_ID,
          12345 as unknown as string,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('responde 429 a quem já abriu 20 conversas hoje', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.count.mockResolvedValue(20);

      let refusal: unknown;
      try {
        await service.startConversation(CLIENT_ID, {
          equipmentId: EQUIPMENT_ID,
          firstMessage: 'Faço mais barato fora da app.',
        });
      } catch (error) {
        refusal = error;
      }

      expect((refusal as HttpException).getStatus()).toBe(429);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('escrever numa conversa que já existe não conta como conversa nova', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(makeConversation());
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.conversation.count.mockResolvedValue(20);
      prisma.$transaction.mockResolvedValue([makeMessage(), {}]);

      const result = await service.startConversation(CLIENT_ID, {
        equipmentId: EQUIPMENT_ID,
        firstMessage: 'Afinal pode ser na terça?',
      });

      expect(result.data.isNew).toBe(false);
    });
  });

  describe('quem pode abrir a conversa', () => {
    const asUser = (id: string) =>
      prisma.user.findUnique.mockResolvedValue(makeUser(id, UserRole.PROVIDER));

    const createInTransaction = () =>
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.conversation.create.mockResolvedValue(makeConversation());
          prisma.message.create.mockResolvedValue(
            makeMessage({ senderId: OWNER_ID }),
          );
          return cb(prisma);
        },
      );

    it('recusa o anúncio de uma conta suspensa', async () => {
      asUser(CLIENT_ID);
      prisma.equipment.findUnique.mockResolvedValue(
        makeEquipment({ owner: { isActive: false } }),
      );

      await expect(
        service.startConversation(CLIENT_ID, {
          equipmentId: EQUIPMENT_ID,
          firstMessage: 'Está disponível?',
        }),
      ).rejects.toThrow(
        new NotFoundException('Equipamento não encontrado ou indisponível.'),
      );
    });

    it('deixa o dono do anúncio escrever a um cliente com reserva nele', async () => {
      asUser(OWNER_ID);
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.booking.findFirst.mockResolvedValue({ id: 'booking-uuid-001' });
      prisma.conversation.findFirst.mockResolvedValue(null);
      createInTransaction();

      const result = await service.startConversation(OWNER_ID, {
        equipmentId: EQUIPMENT_ID,
        clientId: CLIENT_ID,
        firstMessage: 'A que horas posso entregar?',
      });

      expect(result.data.isNew).toBe(true);
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: CLIENT_ID,
            ownerId: OWNER_ID,
            equipmentId: EQUIPMENT_ID,
            serviceId: null,
          },
        }),
      );
      // Quem escreve ao seu próprio cliente não gasta o tecto diário.
      expect(prisma.conversation.count).not.toHaveBeenCalled();
    });

    it('recusa ao dono do anúncio um cliente sem reserva nele', async () => {
      asUser(OWNER_ID);
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });
      prisma.booking.findFirst.mockResolvedValue(null);

      await expect(
        service.startConversation(OWNER_ID, {
          equipmentId: EQUIPMENT_ID,
          clientId: CLIENT_ID,
          firstMessage: 'Tenho uma oferta para si.',
        }),
      ).rejects.toThrow(
        new ForbiddenException(
          'Só podes escrever a um cliente que tenha uma reserva ou um pedido neste anúncio.',
        ),
      );
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('recusa quem indica um cliente num anúncio que não é seu', async () => {
      asUser(STRANGER_ID);
      prisma.equipment.findUnique.mockResolvedValue({
        id: EQUIPMENT_ID,
        ownerId: OWNER_ID,
      });

      await expect(
        service.startConversation(STRANGER_ID, {
          equipmentId: EQUIPMENT_ID,
          clientId: CLIENT_ID,
          firstMessage: 'Olá.',
        }),
      ).rejects.toThrow(
        new ForbiddenException(
          'Só o dono do anúncio pode iniciar a conversa com um cliente.',
        ),
      );
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
    });

    it('recusa uma conversa consigo próprio', async () => {
      asUser(OWNER_ID);

      await expect(
        service.startConversation(OWNER_ID, {
          equipmentId: EQUIPMENT_ID,
          clientId: OWNER_ID,
          firstMessage: 'Olá.',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('num serviço, procura o pedido do cliente', async () => {
      asUser(OWNER_ID);
      prisma.service.findUnique.mockResolvedValue({
        id: 'service-uuid-001',
        providerId: OWNER_ID,
      });
      prisma.serviceRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.startConversation(OWNER_ID, {
          serviceId: 'service-uuid-001',
          clientId: CLIENT_ID,
          firstMessage: 'Quando posso passar?',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.serviceRequest.findFirst).toHaveBeenCalledWith({
        where: { serviceId: 'service-uuid-001', clientId: CLIENT_ID },
        select: { id: true },
      });
    });
  });

  describe('dois pedidos iguais ao mesmo tempo', () => {
    it('escreve na conversa que o outro pedido acabou de criar', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeConversation());
      prisma.$transaction
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce([makeMessage(), {}]);
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());

      const result = await service.startConversation(CLIENT_ID, {
        equipmentId: EQUIPMENT_ID,
        firstMessage: 'Está disponível?',
      });

      expect(result.data.isNew).toBe(false);
      expect(result.data.conversation.id).toBe(CONVERSATION_ID);
    });

    it('deixa passar os outros erros da base como estão', async () => {
      const failure = new Error('ligação perdida');
      prisma.user.findUnique.mockResolvedValue(
        makeUser(CLIENT_ID, UserRole.CLIENT),
      );
      prisma.equipment.findUnique.mockResolvedValue(makeEquipment());
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue(failure);

      await expect(
        service.startConversation(CLIENT_ID, {
          equipmentId: EQUIPMENT_ID,
          firstMessage: 'Está disponível?',
        }),
      ).rejects.toBe(failure);
    });
  });

  describe('leitura', () => {
    it('não marca nada como lido numa página vazia', async () => {
      prisma.conversation.findUnique.mockResolvedValue(makeConversation());
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.findConversation(CLIENT_ID, CONVERSATION_ID, {});

      expect(prisma.message.updateMany).not.toHaveBeenCalled();
    });

    it('a lista de conversas traz as mensagens por ler de cada uma e a paginação', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        makeConversation({ _count: { messages: 3 } }),
      ]);
      prisma.conversation.count.mockResolvedValue(41);

      const result = await service.findMyConversations(CLIENT_ID, {
        page: 2,
        limit: 20,
      });

      expect(result.data[0].unreadCount).toBe(3);
      expect(result.meta).toMatchObject({
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      });
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('assertParticipant confirma a pertença sem ler mensagens', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        ownerId: OWNER_ID,
      });

      await service.assertParticipant(OWNER_ID, CONVERSATION_ID);

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
      await expect(
        service.assertParticipant(STRANGER_ID, CONVERSATION_ID),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
