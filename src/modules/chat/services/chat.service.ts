import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, UserRole } from '@prisma/client';

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

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Iniciar conversa (CLIENT) ────────────────────────────────────────────

  async startConversation(clientId: string, dto: StartConversationDto) {
    // Verificar se o utilizador é CLIENT
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });

    if (!client) throw new NotFoundException('Utilizador não encontrado.');

    if (client.role !== UserRole.CLIENT) {
      throw new ForbiddenException(
        'Só clientes podem iniciar conversas.',
      );
    }

    // Verificar se o equipment existe e está activo
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: dto.equipmentId },
      select: { id: true, ownerId: true, status: true, title: true },
    });

    if (!equipment || equipment.status !== EquipmentStatus.ACTIVE) {
      throw new NotFoundException('Equipamento não encontrado ou indisponível.');
    }

    // Cliente não pode contactar o seu próprio equipment
    if (equipment.ownerId === clientId) {
      throw new BadRequestException(
        'Não podes iniciar uma conversa sobre o teu próprio equipamento.',
      );
    }

    // Verificar se já existe conversa entre este cliente e owner sobre este equipment
    const existing = await this.prisma.conversation.findUnique({
      where: {
        clientId_ownerId_equipmentId: {
          clientId,
          ownerId: equipment.ownerId,
          equipmentId: dto.equipmentId,
        },
      },
      include: {
        client: { select: USER_SELECT },
        owner: { select: USER_SELECT },
        equipment: { select: EQUIPMENT_SELECT },
      },
    });

    if (existing) {
      // Conversa já existe — envia a mensagem na conversa existente e devolve
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

    // Criar conversa e primeira mensagem numa transacção
    const now = new Date();
    const { conversation, msg } = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          clientId,
          ownerId: equipment.ownerId,
          equipmentId: dto.equipmentId,
          lastMessage: dto.firstMessage,
          lastMessageAt: now,
        },
        include: {
          client: { select: USER_SELECT },
          owner: { select: USER_SELECT },
          equipment: { select: EQUIPMENT_SELECT },
        },
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

  // ─── Listar conversas do utilizador ───────────────────────────────────────

  async findMyConversations(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ clientId: userId }, { ownerId: userId }],
      },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        client: { select: USER_SELECT },
        owner: { select: USER_SELECT },
        equipment: { select: EQUIPMENT_SELECT },
      },
    });

    return {
      message: 'Conversas obtidas com sucesso.',
      data: conversations.map((conv) =>
        ChatPresenter.toConversation(conv, userId),
      ),
    };
  }

  // ─── Detalhe de uma conversa + mensagens ─────────────────────────────────

  async findConversation(userId: string, conversationId: string, query: FindMessagesQueryDto) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        client: { select: USER_SELECT },
        owner: { select: USER_SELECT },
        equipment: { select: EQUIPMENT_SELECT },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada.');
    }

    // Verificar se o utilizador é participante
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
        orderBy: { createdAt: 'desc' }, // mais recentes primeiro
        skip,
        take: limit,
        include: { sender: { select: USER_SELECT } },
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);

    // Marcar como lidas as mensagens do outro utilizador
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
        messages: messages.map(ChatPresenter.toMessage),
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

  // ─── Enviar mensagem (usado pelo WebSocket gateway e REST fallback) ────────

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
      // Actualizar cache de última mensagem na conversa
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessage: trimmed, lastMessageAt: now },
      }),
    ]);

    return message;
  }

  // ─── Contar mensagens não lidas (para badge na UI) ────────────────────────

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
