import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma, ServiceStatus } from '@prisma/client';

import { CHAT_NEW_CONVERSATIONS_PER_DAY } from '../../../shared/constants/policy';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PushService } from '../../../shared/push/push.service';
import {
  ChatRateLimiter,
  TOO_MANY_NEW_CONVERSATIONS,
  tooManyRequests,
} from '../chat-rate-limit';
import {
  FindConversationsQueryDto,
  FindMessagesQueryDto,
  StartConversationDto,
} from '../dto/chat.dto';
import { ChatPresenter } from '../presenters/chat.presenter';

const USER_SELECT = { id: true, name: true, avatarUrl: true };

const PRIMARY_PHOTO = {
  where: { isPrimary: true },
  take: 1,
  select: { url: true },
};

const CONVERSATION_INCLUDE = {
  client: { select: USER_SELECT },
  owner: { select: USER_SELECT },
  equipment: { select: { id: true, title: true, photos: PRIMARY_PHOTO } },
  service: { select: { id: true, title: true, photos: PRIMARY_PHOTO } },
} as const;

const MESSAGE_INCLUDE = { sender: { select: USER_SELECT } } as const;

const MAX_MESSAGE_LENGTH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONVERSATIONS_PAGE_SIZE = 30;

/** As duas pontas de uma conversa e o anúncio de que ela trata. */
interface ConversationKey {
  clientId: string;
  ownerId: string;
  equipmentId: string | null;
  serviceId: string | null;
}

/** O índice único da base recusou uma segunda conversa igual. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly limiter: ChatRateLimiter,
  ) {}

  /**
   * Abre uma conversa sobre um anúncio, ou escreve na que já existe.
   *
   * Sem `clientId`, quem pede é o interessado e fala com o dono do anúncio.
   * Com `clientId`, quem pede é o dono do anúncio e fala com um cliente que
   * tem uma reserva ou um pedido nesse anúncio.
   */
  async startConversation(userId: string, dto: StartConversationDto) {
    if (Boolean(dto.equipmentId) === Boolean(dto.serviceId)) {
      throw new BadRequestException(
        'Forneça exactamente um de equipmentId ou serviceId.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) throw new NotFoundException('Utilizador não encontrado.');

    const firstMessage = this.cleanContent(dto.firstMessage);
    const key = dto.clientId
      ? await this.keyAsOwner(userId, dto, dto.clientId)
      : await this.keyAsInterested(userId, dto);

    const existing = await this.findByKey(key);
    if (existing) {
      return this.replyInExisting(userId, existing, firstMessage);
    }

    if (!dto.clientId) {
      await this.assertMayOpenConversation(userId);
    }
    this.limiter.assertMayPost(userId);

    let created: Awaited<ReturnType<ChatService['createWithFirstMessage']>>;
    try {
      created = await this.createWithFirstMessage(key, userId, firstMessage);
    } catch (error) {
      // Dois pedidos iguais ao mesmo tempo: o índice único da base deixa
      // criar uma conversa só, e a segunda mensagem vai para ela.
      const winner = isUniqueViolation(error)
        ? await this.findByKey(key)
        : null;

      if (!winner) throw error;

      return this.replyInExisting(userId, winner, firstMessage);
    }

    const { conversation, message } = created;

    this.notify(
      userId === key.clientId ? key.ownerId : key.clientId,
      '💬 Nova mensagem',
      `${message.sender.name}: ${firstMessage.substring(0, 60)}`,
      conversation.id,
    );

    return {
      message: 'Conversa iniciada com sucesso.',
      data: {
        conversation: ChatPresenter.toConversation(conversation, userId),
        message: ChatPresenter.toMessage(message),
        isNew: true,
      },
    };
  }

  async findMyConversations(
    userId: string,
    query: FindConversationsQueryDto = {},
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_CONVERSATIONS_PAGE_SIZE;
    const where: Prisma.ConversationWhereInput = {
      OR: [{ clientId: userId }, { ownerId: userId }],
    };

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          ...CONVERSATION_INCLUDE,
          // As mensagens do outro que este utilizador ainda não leu.
          _count: {
            select: {
              messages: {
                where: { isRead: false, senderId: { not: userId } },
              },
            },
          },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return {
      message: 'Conversas obtidas com sucesso.',
      data: conversations.map((conversation) =>
        ChatPresenter.toConversation(conversation, userId),
      ),
      meta: this.pageMeta(page, limit, total),
    };
  }

  async findConversation(
    userId: string,
    conversationId: string,
    query: FindMessagesQueryDto,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });

    if (!conversation) throw new NotFoundException('Conversa não encontrada.');

    if (conversation.clientId !== userId && conversation.ownerId !== userId) {
      throw new ForbiddenException('Não tens acesso a esta conversa.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 30;

    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: MESSAGE_INCLUDE,
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);

    // Só fica lido o que foi entregue: até à mensagem mais recente desta
    // página. Antes, pedir uma página antiga dava por lidas mensagens novas
    // que o utilizador nunca chegou a receber.
    const newest = messages[0]?.createdAt;
    if (newest) {
      await this.prisma.message.updateMany({
        where: {
          conversationId,
          senderId: { not: userId },
          isRead: false,
          createdAt: { lte: newest },
        },
        data: { isRead: true },
      });
    }

    return {
      message: 'Conversa obtida com sucesso.',
      data: {
        conversation: ChatPresenter.toConversation(conversation, userId),
        messages: messages.map((m) => ChatPresenter.toMessage(m)),
        meta: this.pageMeta(page, limit, total),
      },
    };
  }

  /**
   * Confirma que o utilizador é uma das duas pontas da conversa. Não lê nem
   * marca mensagens: é o que o socket usa para deixar entrar numa conversa.
   */
  async assertParticipant(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, clientId: true, ownerId: true },
    });

    if (!conversation) throw new NotFoundException('Conversa não encontrada.');

    if (conversation.clientId !== userId && conversation.ownerId !== userId) {
      throw new ForbiddenException('Não tens acesso a esta conversa.');
    }

    return conversation;
  }

  async sendMessageToConversation(
    senderId: string,
    conversationId: string,
    content: string,
  ) {
    const text = this.cleanContent(content);
    const conversation = await this.assertParticipant(senderId, conversationId);

    this.limiter.assertMayPost(senderId);

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId, senderId, content: text },
        include: MESSAGE_INCLUDE,
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: text, lastMessageAt: new Date() },
      }),
    ]);

    this.notify(
      conversation.clientId === senderId
        ? conversation.ownerId
        : conversation.clientId,
      `💬 ${message.sender.name}`,
      text.substring(0, 100),
      conversationId,
    );

    return message;
  }

  async countUnread(userId: string) {
    const count = await this.prisma.message.count({
      where: {
        conversation: {
          OR: [{ clientId: userId }, { ownerId: userId }],
        },
        senderId: { not: userId },
        isRead: false,
      },
    });

    return {
      message: 'Contagem obtida com sucesso.',
      data: { unreadCount: count },
    };
  }

  // Quem fala com quem

  /** O interessado escreve ao dono de um anúncio que está no catálogo. */
  private async keyAsInterested(
    userId: string,
    dto: StartConversationDto,
  ): Promise<ConversationKey> {
    if (dto.equipmentId) {
      const equipment = await this.prisma.equipment.findUnique({
        where: { id: dto.equipmentId },
        select: {
          id: true,
          ownerId: true,
          status: true,
          owner: { select: { isActive: true } },
        },
      });

      // Fora do catálogo, ou de uma conta suspensa, não se abre conversa.
      if (
        !equipment ||
        equipment.status !== EquipmentStatus.ACTIVE ||
        !equipment.owner.isActive
      ) {
        throw new NotFoundException(
          'Equipamento não encontrado ou indisponível.',
        );
      }

      if (equipment.ownerId === userId) {
        throw new BadRequestException(
          'Não podes iniciar uma conversa sobre o teu próprio equipamento.',
        );
      }

      return {
        clientId: userId,
        ownerId: equipment.ownerId,
        equipmentId: equipment.id,
        serviceId: null,
      };
    }

    const service = await this.prisma.service.findUnique({
      where: { id: dto.serviceId as string },
      select: {
        id: true,
        providerId: true,
        status: true,
        isActive: true,
        provider: { select: { isActive: true } },
      },
    });

    if (
      !service ||
      service.status !== ServiceStatus.ACTIVE ||
      !service.isActive ||
      !service.provider.isActive
    ) {
      throw new NotFoundException('Serviço não encontrado ou indisponível.');
    }

    if (service.providerId === userId) {
      throw new BadRequestException(
        'Não podes iniciar uma conversa sobre o teu próprio serviço.',
      );
    }

    return {
      clientId: userId,
      ownerId: service.providerId,
      equipmentId: null,
      serviceId: service.id,
    };
  }

  /**
   * O dono do anúncio escreve a um cliente. Só a quem já tem uma reserva
   * (equipamento) ou um pedido (serviço) nesse anúncio: é o que o deixa
   * combinar a entrega sem lhe dar forma de escrever a qualquer conta.
   */
  private async keyAsOwner(
    userId: string,
    dto: StartConversationDto,
    clientId: string,
  ): Promise<ConversationKey> {
    if (clientId === userId) {
      throw new BadRequestException(
        'Não podes iniciar uma conversa contigo próprio.',
      );
    }

    const listing = dto.equipmentId
      ? await this.prisma.equipment.findUnique({
          where: { id: dto.equipmentId },
          select: { id: true, ownerId: true },
        })
      : await this.prisma.service
          .findUnique({
            where: { id: dto.serviceId as string },
            select: { id: true, providerId: true },
          })
          .then((service) =>
            service ? { id: service.id, ownerId: service.providerId } : null,
          );

    if (!listing) {
      throw new NotFoundException('Anúncio não encontrado.');
    }

    if (listing.ownerId !== userId) {
      throw new ForbiddenException(
        'Só o dono do anúncio pode iniciar a conversa com um cliente.',
      );
    }

    const dealt = dto.equipmentId
      ? await this.prisma.booking.findFirst({
          where: { equipmentId: listing.id, clientId },
          select: { id: true },
        })
      : await this.prisma.serviceRequest.findFirst({
          where: { serviceId: listing.id, clientId },
          select: { id: true },
        });

    if (!dealt) {
      throw new ForbiddenException(
        'Só podes escrever a um cliente que tenha uma reserva ou um pedido neste anúncio.',
      );
    }

    return {
      clientId,
      ownerId: userId,
      equipmentId: dto.equipmentId ? listing.id : null,
      serviceId: dto.equipmentId ? null : listing.id,
    };
  }

  // Ajudas privadas

  private findByKey(key: ConversationKey) {
    return this.prisma.conversation.findFirst({
      where: key,
      include: CONVERSATION_INCLUDE,
    });
  }

  private async replyInExisting(
    userId: string,
    existing: NonNullable<Awaited<ReturnType<ChatService['findByKey']>>>,
    firstMessage: string,
  ) {
    const message = await this.sendMessageToConversation(
      userId,
      existing.id,
      firstMessage,
    );

    return {
      message: 'Mensagem enviada na conversa existente.',
      data: {
        conversation: ChatPresenter.toConversation(existing, userId),
        message: ChatPresenter.toMessage(message),
        isNew: false,
      },
    };
  }

  private createWithFirstMessage(
    key: ConversationKey,
    senderId: string,
    firstMessage: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: { ...key, lastMessage: firstMessage, lastMessageAt: new Date() },
        include: CONVERSATION_INCLUDE,
      });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId,
          content: firstMessage,
        },
        include: MESSAGE_INCLUDE,
      });

      return { conversation, message };
    });
  }

  /**
   * Tecto de conversas novas por dia, para um script não percorrer o
   * catálogo a escrever a todos os providers. Conta as conversas em que a
   * conta é o cliente, abertas nas últimas 24 horas. As que um provider lhe
   * abriu também contam: é uma aproximação, e o tecto é folgado.
   */
  private async assertMayOpenConversation(userId: string) {
    const openedToday = await this.prisma.conversation.count({
      where: {
        clientId: userId,
        createdAt: { gt: new Date(Date.now() - DAY_MS) },
      },
    });

    if (openedToday >= CHAT_NEW_CONVERSATIONS_PER_DAY) {
      throw tooManyRequests(TOO_MANY_NEW_CONVERSATIONS);
    }
  }

  private cleanContent(content: unknown): string {
    const text = typeof content === 'string' ? content.trim() : '';

    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        'Mensagem inválida. Deve ter entre 1 e 1000 caracteres.',
      );
    }

    return text;
  }

  /**
   * Aviso push ao destinatário, sem fazer esperar quem enviou. Se falhar, a
   * mensagem já está gravada e o aviso perde-se sem mais consequências.
   */
  private notify(
    recipientId: string,
    title: string,
    body: string,
    conversationId: string,
  ) {
    void this.sendPush(recipientId, title, body, conversationId);
  }

  private async sendPush(
    recipientId: string,
    title: string,
    body: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const recipient = await this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { pushToken: true },
      });

      if (recipient?.pushToken) {
        await this.push.send({
          to: recipient.pushToken,
          title,
          body,
          data: { type: 'chat', conversationId },
        });
      }
    } catch {
      // Um aviso que falha não trava a conversa.
    }
  }

  private pageMeta(page: number, limit: number, total: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    };
  }
}
