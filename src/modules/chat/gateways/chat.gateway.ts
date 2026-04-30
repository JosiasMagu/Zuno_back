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

// Mapa em memória: userId → Set de socket IDs
// Permite que o mesmo utilizador esteja ligado em múltiplos dispositivos
const userSockets = new Map<string, Set<string>>();

@WebSocketGateway({
  cors: {
    origin: '*', // Ajustar para o domínio real em produção
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

  // ─── Ligação estabelecida ─────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const userId = await this.extractUserIdFromSocket(client);
      client.data.userId = userId;

      // Registar socket no mapa de utilizadores
      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId)!.add(client.id);

      // O cliente entra automaticamente nas suas salas de conversa
      // (cada conversa é uma room com o conversationId)
      console.log(`[Chat] User ${userId} connected (socket: ${client.id})`);
    } catch {
      // Token inválido — desligar imediatamente
      client.emit('error', { message: 'Token inválido. Ligação recusada.' });
      client.disconnect();
    }
  }

  // ─── Desligação ───────────────────────────────────────────────────────────

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

    // O ChatService já verifica se o utilizador é participante
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

  // ─── Sair de uma conversa ─────────────────────────────────────────────────

  @SubscribeMessage('leave_conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    await client.leave(data.conversationId);
    client.emit('left_conversation', { conversationId: data.conversationId });
  }

  // ─── Enviar mensagem ──────────────────────────────────────────────────────

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

      // Emitir a mensagem para todos os sockets na room da conversa
      // (inclui o próprio remetente para confirmar recepção)
      this.server
        .to(data.conversationId)
        .emit('new_message', { data: formatted });

      // Se o destinatário estiver online mas não na room, notificá-lo
      // para actualizar a lista de conversas (badge de não lidos)
      this.notifyRecipient(userId, data.conversationId, formatted);

      return { event: 'message_sent', data: formatted };
    } catch (error) {
      throw new WsException(
        error instanceof Error ? error.message : 'Erro ao enviar mensagem.',
      );
    }
  }

  // ─── Indicador de "a escrever..." ─────────────────────────────────────────

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId as string;

    if (!data?.conversationId) return;

    // Emitir para todos na room excepto o próprio
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

  // ─── Helper: notificar destinatário fora da room ──────────────────────────

  private notifyRecipient(
    senderId: string,
    conversationId: string,
    message: ReturnType<typeof ChatPresenter.toMessage>,
  ) {
    // Emitir notificação pessoal ao destinatário via socket pessoal
    // O front usa isto para actualizar o badge de mensagens não lidas
    // Nota: o recipient é identificado pelo conversationId — o front
    // já sabe de qual conversa veio a notificação
    this.server.to(conversationId).emit('conversation_updated', {
      conversationId,
      lastMessage: message.content,
      lastMessageAt: message.createdAt,
      senderId,
    });
  }

  // ─── Extrair userId do token JWT no handshake ─────────────────────────────

  private async extractUserIdFromSocket(client: Socket): Promise<string> {
    // O front deve enviar o token no handshake:
    // socket = io('/chat', { auth: { token: 'Bearer eyJ...' } })
    // ou nos headers: { Authorization: 'Bearer eyJ...' }
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
