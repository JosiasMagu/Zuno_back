import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, ServiceStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { FindMessagesQueryDto, StartConversationDto } from '../dto/chat.dto';
import { ChatPresenter } from '../presenters/chat.presenter';

const USER_SELECT = { id: true, name: true, avatarUrl: true };

const EQUIPMENT_SELECT = {
  id: true,
  title: true,
  photos: {
    where: { isPrimary: true },
    take: 1,
    select: { url: true },
  },
};

const SERVICE_SELECT = {
  id: true,
  title: true,
  photos: {
    where: { isPrimary: true },
    take: 1,
    select: { url: true },
  },
};

const CONVERSATION_INCLUDE = {
  client: { select: USER_SELECT },
  owner: { select: USER_SELECT },
  equipment: { select: EQUIPMENT_SELECT },
  service: { select: SERVICE_SELECT },
} as const;

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  // Iniciar conversa (CLIENT)

  async startConversation(clientId: string, dto: StartConversationDto) {
    const hasEquipment = Boolean(dto.equipmentId);
    const hasService = Boolean(dto.serviceId);

    if (hasEquipment === hasService) {
      throw new BadRequestException(
        'Forneça exactamente um de equipmentId ou serviceId.',
      );
    }

    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });

    if (!client) throw new NotFoundException('Utilizador não encontrado.');

    if (client.role !== UserRole.CLIENT) {
      throw new ForbiddenException('Só clientes podem iniciar conversas.');
    }

    const target = hasEquipment
      ? await this.resolveEquipmentTarget(dto.equipmentId as string, clientId)
      : await this.resolveServiceTarget(dto.serviceId as string, clientId);

    const existing = await this.prisma.conversation.findFirst({
      where: {
        clientId,
        ownerId: target.providerId,
        equipmentId: target.equipmentId,
        serviceId: target.serviceId,
      },
      include: CONVERSATION_INCLUDE,
    });

    if (existing) {
      const message = await this.sendMessageToConversation(
        clientId,
        existing.id,
        dto.firstMessage,
      );

      return {
        message: 'Mensagem enviada na conversa existente.',
        data: {
          conversation: ChatPresenter.toConversation(existing, clientId),
          message: ChatPresenter.toMessage(message),
          isNew: false,
        },
      };
    }

    const now = new Date();
    const { conversation, msg } = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          clientId,
          ownerId: target.providerId,
          equipmentId: target.equipmentId,
          serviceId: target.serviceId,
          lastMessage: dto.firstMessage,
          lastMessageAt: now,
        },
        include: CONVERSATION_INCLUDE,
      });

      const msg = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: clientId,
          content: dto.firstMessage,
        },
        include: { sender: { select: USER_SELECT } },
      });

      return { conversation, msg };
    });

    return {
      message: 'Conversa iniciada com sucesso.',
      data: {
        conversation: ChatPresenter.toConversation(conversation, clientId),
        message: ChatPresenter.toMessage(msg),
        isNew: true,
      },
    };
  }

  private async resolveEquipmentTarget(equipmentId: string, clientId: string) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, ownerId: true, status: true },
    });

    if (!equipment || equipment.status !== EquipmentStatus.ACTIVE) {
      throw new NotFoundException(
        'Equipamento não encontrado ou indisponível.',
      );
    }

    if (equipment.ownerId === clientId) {
      throw new BadRequestException(
        'Não podes iniciar uma conversa sobre o teu próprio equipamento.',
      );
    }

    return {
      providerId: equipment.ownerId,
      equipmentId: equipment.id,
      serviceId: null,
    };
  }

  private async resolveServiceTarget(serviceId: string, clientId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, providerId: true, status: true, isActive: true },
    });

    if (
      !service ||
      service.status !== ServiceStatus.ACTIVE ||
      !service.isActive
    ) {
      throw new NotFoundException('Serviço não encontrado ou indisponível.');
    }

    if (service.providerId === clientId) {
      throw new BadRequestException(
        'Não podes iniciar uma conversa sobre o teu próprio serviço.',
      );
    }

    return {
      providerId: service.providerId,
      equipmentId: null,
      serviceId: service.id,
    };
  }

  async findMyConversations(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ clientId: userId }, { ownerId: userId }],
      },
      orderBy: { lastMessageAt: 'desc' },
      include: CONVERSATION_INCLUDE,
    });

    return {
      message: 'Conversas obtidas com sucesso.',
      data: conversations.map((conv) =>
        ChatPresenter.toConversation(conv, userId),
      ),
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

    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada.');
    }

    const isParticipant =
      conversation.clientId === userId || conversation.ownerId === userId;

    if (!isParticipant) {
      throw new ForbiddenException('Não tens acesso a esta conversa.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { sender: { select: USER_SELECT } },
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);

    await this.prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });

    return {
      message: 'Conversa obtida com sucesso.',
      data: {
        conversation: ChatPresenter.toConversation(conversation, userId),
        messages: messages.map((m) => ChatPresenter.toMessage(m)),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPreviousPage: page > 1,
        },
      },
    };
  }

  async sendMessageToConversation(
    senderId: string,
    conversationId: string,
    content: string,
  ) {
    const trimmed = content.trim();

    if (!trimmed || trimmed.length > 1000) {
      throw new BadRequestException(
        'Mensagem inválida. Deve ter entre 1 e 1000 caracteres.',
      );
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, clientId: true, ownerId: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada.');
    }

    const isParticipant =
      conversation.clientId === senderId || conversation.ownerId === senderId;

    if (!isParticipant) {
      throw new ForbiddenException('Não tens acesso a esta conversa.');
    }

    const now = new Date();

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId, senderId, content: trimmed },
        include: { sender: { select: USER_SELECT } },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: trimmed, lastMessageAt: now },
      }),
    ]);

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
}
