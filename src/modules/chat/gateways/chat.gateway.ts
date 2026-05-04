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
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService, TokenExpiredError, JsonWebTokenError } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { ChatService } from '../services/chat.service';
import { ChatPresenter } from '../presenters/chat.presenter';

// Tipo do payload JWT que esperamos receber no handshake
interface JwtPayload {
  sub: string;
  phone?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

// Socket com data tipada — evita os 'any' em client.data.userId
interface AuthenticatedSocket extends Socket {
  data: {
    userId?: string;
  };
}

const userSockets = new Map<string, Set<string>>();

@WebSocketGateway({
  cors: {
    origin: (
      process.env.ALLOWED_ORIGINS ??
      'http://localhost:3000,http://localhost:8081'
    )
      .split(',')
      .map((o: string) => o.trim())
      .filter((o: string) => o.length > 0),
    credentials: true,
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Ciclo de vida da conexão ─────────────────────────────────────────────

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const userId = this.extractUserIdFromSocket(client);
      client.data.userId = userId;

      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId)!.add(client.id);

      this.logger.log(`User ${userId} connected (socket: ${client.id})`);
      await Promise.resolve();
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.logger.debug(
          `Connection rejected — ${error.message} (socket: ${client.id})`,
        );
      } else {
        this.logger.error(
          `Unexpected error during connection (socket: ${client.id})`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      client.emit('error', { message: 'Token inválido. Ligação recusada.' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data.userId;
    if (userId) {
      userSockets.get(userId)?.delete(client.id);
      if (userSockets.get(userId)?.size === 0) {
        userSockets.delete(userId);
      }
      this.logger.log(`User ${userId} disconnected (socket: ${client.id})`);
    }
  }

  // ─── Entrar/sair de conversas ─────────────────────────────────────────────

  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;

    if (!userId) {
      throw new WsException('Não autenticado.');
    }

    if (!data?.conversationId) {
      throw new WsException('conversationId é obrigatório.');
    }

    try {
      await this.chatService.findConversation(userId, data.conversationId, {
        page: 1,
        limit: 1,
      });
    } catch (error) {
      this.logger.warn(
        `User ${userId} denied access to conversation ${data.conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new WsException('Não tens acesso a esta conversa.');
    }

    await client.join(data.conversationId);
    client.emit('joined_conversation', { conversationId: data.conversationId });
  }

  @SubscribeMessage('leave_conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    await client.leave(data.conversationId);
    client.emit('left_conversation', { conversationId: data.conversationId });
  }

  // ─── Envio de mensagens ───────────────────────────────────────────────────

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    const userId = client.data.userId;

    if (!userId) {
      throw new WsException('Não autenticado.');
    }

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
      const message =
        error instanceof Error ? error.message : 'Erro ao enviar mensagem.';

      if (this.isExpectedBusinessError(error)) {
        this.logger.warn(
          `Message rejected for user ${userId} in conversation ${data.conversationId}: ${message}`,
        );
      } else {
        this.logger.error(
          `Failed to send message for user ${userId} in conversation ${data.conversationId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      throw new WsException(message);
    }
  }

  // ─── Indicadores de digitação ─────────────────────────────────────────────

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.conversationId) return;
    client.to(data.conversationId).emit('user_typing', { userId });
  }

  @SubscribeMessage('stop_typing')
  handleStopTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.conversationId) return;
    client.to(data.conversationId).emit('user_stop_typing', { userId });
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

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

  private extractUserIdFromSocket(client: Socket): string {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const headers = client.handshake.headers as
      | { authorization?: unknown }
      | undefined;

    const tokenFromAuth =
      typeof auth?.token === 'string' ? auth.token : undefined;
    const tokenFromHeader =
      typeof headers?.authorization === 'string'
        ? headers.authorization
        : undefined;

    const authHeader = tokenFromAuth ?? tokenFromHeader;

    if (!authHeader) {
      throw new UnauthorizedException('Token não fornecido.');
    }

    const token = authHeader.replace('Bearer ', '').trim();

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });

      if (!payload?.sub) {
        throw new UnauthorizedException('Token inválido — sem subject.');
      }

      return payload.sub;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedException('Token expirado.');
      }
      if (error instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Token mal formado.');
      }
      throw error;
    }
  }

  private isExpectedBusinessError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const businessKeywords = [
      'não tens acesso',
      'não pertences',
      'conversa não encontrada',
      'utilizador não encontrado',
      'mensagem vazia',
    ];
    return businessKeywords.some((kw) =>
      error.message.toLowerCase().includes(kw),
    );
  }
}
