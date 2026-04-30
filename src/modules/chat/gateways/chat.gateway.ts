import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { ChatService } from '../services/chat.service';
import { ChatPresenter } from '../presenters/chat.presenter';

const userSockets = new Map<string, Set<string>>();

@WebSocketGateway({
  cors: {
    origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:8081')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}


  async handleConnection(client: Socket) {
    try {
      const userId = await this.extractUserIdFromSocket(client);
      client.data.userId = userId;

      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId)!.add(client.id);

      console.log(`[Chat] User ${userId} connected (socket: ${client.id})`);
    } catch {
      client.emit('error', { message: 'Token inválido. Ligação recusada.' });
      client.disconnect();
    }
  }


  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId) {
      userSockets.get(userId)?.delete(client.id);
      if (userSockets.get(userId)?.size === 0) {
        userSockets.delete(userId);
      }
      console.log(`[Chat] User ${userId} disconnected (socket: ${client.id})`);
    }
  }

  // ─── Entrar numa conversa (subscrever à room) ─────────────────────────────

  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId as string;

    if (!data?.conversationId) {
      throw new WsException('conversationId é obrigatório.');
    }

    try {
      await this.chatService.findConversation(userId, data.conversationId, {
        page: 1,
        limit: 1,
      });
    } catch {
      throw new WsException('Não tens acesso a esta conversa.');
    }

    await client.join(data.conversationId);
    client.emit('joined_conversation', { conversationId: data.conversationId });
  }


  @SubscribeMessage('leave_conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    await client.leave(data.conversationId);
    client.emit('left_conversation', { conversationId: data.conversationId });
  }


  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    const userId = client.data.userId as string;

    if (!data?.conversationId || !data?.content) {
      throw new WsException('conversationId e content são obrigatórios.');
    }

    try {
      const message = await this.chatService.sendMessageToConversation(
        userId,
        data.conversationId,
        data.content,
      );

      const formatted = ChatPresenter.toMessage(message);

      this.server
        .to(data.conversationId)
        .emit('new_message', { data: formatted });

      this.notifyRecipient(userId, data.conversationId, formatted);

      return { event: 'message_sent', data: formatted };
    } catch (error) {
      throw new WsException(
        error instanceof Error ? error.message : 'Erro ao enviar mensagem.',
      );
    }
  }


  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId as string;

    if (!data?.conversationId) return;

    client.to(data.conversationId).emit('user_typing', { userId });
  }

  @SubscribeMessage('stop_typing')
  handleStopTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId as string;

    if (!data?.conversationId) return;

    client.to(data.conversationId).emit('user_stop_typing', { userId });
  }


  private notifyRecipient(
    senderId: string,
    conversationId: string,
    message: ReturnType<typeof ChatPresenter.toMessage>,
  ) {
    this.server.to(conversationId).emit('conversation_updated', {
      conversationId,
      lastMessage: message.content,
      lastMessageAt: message.createdAt,
      senderId,
    });
  }

  // ─── Extrair userId do token JWT no handshake ─────────────────────────────

  private async extractUserIdFromSocket(client: Socket): Promise<string> {
    const authHeader =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization;

    if (!authHeader) {
      throw new Error('Token não fornecido.');
    }

    const token = authHeader.replace('Bearer ', '').trim();

    const payload = this.jwtService.verify(token, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });

    if (!payload?.sub) {
      throw new Error('Token inválido.');
    }

    return payload.sub as string;
  }
}
