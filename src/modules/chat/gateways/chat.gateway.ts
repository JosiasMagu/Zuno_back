import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import { Namespace, Socket } from 'socket.io';

import { LiveConnections } from '../../../shared/realtime/live-connections';
import { ACCESS_TOKEN_TYPE, AccessTokenPayload } from '../../auth/access-token';
import { SessionsService } from '../../auth/services/sessions.service';
import { ChatPresenter } from '../presenters/chat.presenter';
import { ChatService } from '../services/chat.service';

type ChatMessage = ReturnType<typeof ChatPresenter.toMessage>;

/** Quem está do outro lado do socket, depois de autenticado. */
interface ChatSocket extends Socket {
  data: {
    userId?: string;
    sessionId?: string;
    /** Tira a ligação do registo das ligações abertas. */
    unregister?: () => void;
  };
}

const DEFAULT_ORIGINS = 'http://localhost:3000,http://localhost:8081';
const GATEWAY_DISABLED = 'O chat em tempo real está desligado.';
const SESSION_ENDED = 'Sessão terminada.';
const SEND_FAILED = 'Não foi possível enviar a mensagem.';

/**
 * As origens aceites, lidas a cada ligação. No momento em que este ficheiro é
 * carregado o .env ainda não foi lido, por isso uma lista fixa no decorador
 * ficava sempre com os valores por omissão.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  // Apps nativas e ferramentas não enviam origem, como no HTTP.
  if (!origin) {
    return true;
  }

  return (process.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
    .split(',')
    .map((allowed) => allowed.trim())
    .includes(origin);
}

/**
 * O validador global do HTTP não chega aos eventos do socket, por isso o que
 * o cliente envia é lido à mão, campo a campo.
 */
function conversationIdOf(data: unknown): string {
  const id = (data as { conversationId?: unknown } | null)?.conversationId;

  if (typeof id !== 'string' || !isUUID(id)) {
    throw new WsException('conversationId inválido.');
  }

  return id;
}

function contentOf(data: unknown): string {
  const content = (data as { content?: unknown } | null)?.content;

  if (typeof content !== 'string') {
    throw new WsException('content tem de ser texto.');
  }

  return content;
}

/**
 * Chat em tempo real. Fica desligado até `CHAT_GATEWAY_ENABLED=true`: a app
 * usa só o REST, e um socket exposto sem uso é só superfície de ataque.
 *
 * Ligado, segue as regras do HTTP: a sessão do token tem de estar aberta e a
 * conta activa, na ligação e em cada evento.
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, isAllowedOrigin(origin)),
    credentials: true,
  },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessions: SessionsService,
    private readonly live: LiveConnections,
  ) {}

  // Ciclo de vida da ligação

  /**
   * A autenticação corre num middleware do namespace, antes de a ligação ser
   * aceite. Como confirma a sessão na base, é assíncrona: feita depois da
   * ligação, o cliente já estava «ligado» e um evento enviado logo a seguir
   * chegava antes de o servidor saber quem ele era. Assim, o cliente só fica
   * ligado autenticado, e uma recusa chega-lhe como `connect_error`.
   */
  afterInit(namespace: Namespace) {
    namespace.use((socket, next) => {
      this.admit(socket as ChatSocket).then(
        () => next(),
        (error: Error) => next(error),
      );
    });
  }

  /** A ligação já passou pelo middleware, por isso já se sabe de quem é. */
  handleConnection(client: ChatSocket) {
    const { userId, sessionId } = client.data;

    if (!userId || !sessionId) {
      this.refuse(client, 'Não autenticado.');
      return;
    }

    // O logout, a troca de password e a suspensão fecham o socket por aqui.
    client.data.unregister = this.live.register({
      userId,
      sessionId,
      close: () => this.refuse(client, SESSION_ENDED),
    });
  }

  handleDisconnect(client: ChatSocket) {
    client.data.unregister?.();
  }

  // Entrar e sair de conversas

  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: unknown,
  ) {
    const userId = await this.senderOf(client);
    const conversationId = conversationIdOf(data);

    try {
      await this.chatService.assertParticipant(userId, conversationId);
    } catch {
      throw new WsException('Não tens acesso a esta conversa.');
    }

    await client.join(conversationId);
    client.emit('joined_conversation', { conversationId });
  }

  @SubscribeMessage('leave_conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: unknown,
  ) {
    const conversationId = conversationIdOf(data);

    if (!client.rooms.has(conversationId)) {
      return;
    }

    await client.leave(conversationId);
    client.emit('left_conversation', { conversationId });
  }

  // Envio de mensagens

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: unknown,
  ) {
    const userId = await this.senderOf(client);
    const conversationId = conversationIdOf(data);
    const content = contentOf(data);

    try {
      const message = await this.chatService.sendMessageToConversation(
        userId,
        conversationId,
        content,
      );
      const formatted = ChatPresenter.toMessage(message);

      this.broadcastMessage(formatted);

      return { event: 'message_sent', data: formatted };
    } catch (error) {
      throw this.toWsException(error, userId, conversationId);
    }
  }

  // Indicadores de digitação

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: unknown,
  ) {
    this.announceTyping(client, data, 'user_typing');
  }

  @SubscribeMessage('stop_typing')
  handleStopTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: unknown,
  ) {
    this.announceTyping(client, data, 'user_stop_typing');
  }

  /**
   * Avisa quem está ligado a uma conversa de que entrou uma mensagem. Usado
   * pelo socket e também pelo REST, para quem escreve pela app chegar a quem
   * está a ouvir pelo socket.
   */
  broadcastMessage(message: ChatMessage) {
    // Com o gateway desligado ninguém está ligado, e o servidor pode nem
    // existir (nos testes unitários).
    const room = this.server?.to(message.conversationId);

    room?.emit('new_message', { data: message });
    room?.emit('conversation_updated', {
      conversationId: message.conversationId,
      lastMessage: message.content,
      lastMessageAt: message.createdAt,
      senderId: message.senderId,
    });
  }

  // Ajudas privadas

  /**
   * Só fala numa conversa quem entrou nela, e só entra quem lhe pertence
   * (`join_conversation` confirma na base). Sem isto, quem soubesse o id de
   * uma conversa alheia punha lá o aviso «a escrever».
   */
  private announceTyping(client: ChatSocket, data: unknown, event: string) {
    const { userId } = client.data;
    const conversationId = (data as { conversationId?: unknown } | null)
      ?.conversationId;

    if (
      !userId ||
      typeof conversationId !== 'string' ||
      !client.rooms.has(conversationId)
    ) {
      return;
    }

    client.to(conversationId).emit(event, { userId });
  }

  /**
   * Quem enviou o evento, depois de confirmar que a sessão continua aberta.
   * É o que o JwtStrategy faz em cada pedido HTTP: um logout ou uma suspensão
   * cortam o socket ao primeiro evento, mesmo noutra instância.
   */
  private async senderOf(client: ChatSocket): Promise<string> {
    const { userId, sessionId } = client.data;

    if (!userId || !sessionId) {
      throw new WsException('Não autenticado.');
    }

    if (!(await this.sessionIsOpen(sessionId, userId))) {
      this.refuse(client, SESSION_ENDED);
      throw new WsException(SESSION_ENDED);
    }

    return userId;
  }

  /**
   * Deixa entrar o socket ou recusa-o com uma mensagem para o cliente. Uma
   * falha inesperada não mostra pormenores: fica no log.
   */
  private async admit(client: ChatSocket): Promise<void> {
    if (this.configService.get<string>('CHAT_GATEWAY_ENABLED') !== 'true') {
      throw new Error(GATEWAY_DISABLED);
    }

    try {
      const identity = await this.authenticate(client);

      client.data.userId = identity.userId;
      client.data.sessionId = identity.sessionId;
    } catch (error) {
      this.logger.debug(
        `Ligação recusada (socket ${client.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error('Token inválido. Ligação recusada.');
    }
  }

  private async authenticate(
    client: Socket,
  ): Promise<{ userId: string; sessionId: string }> {
    const token = this.readToken(client);

    if (!token) {
      throw new UnauthorizedException('Token não fornecido.');
    }

    let payload: Partial<AccessTokenPayload>;
    try {
      payload = this.jwtService.verify<Partial<AccessTokenPayload>>(token, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    if (payload.typ !== ACCESS_TOKEN_TYPE || !payload.sid || !payload.sub) {
      throw new UnauthorizedException('Token inválido.');
    }

    if (!(await this.sessionIsOpen(payload.sid, payload.sub))) {
      throw new UnauthorizedException(SESSION_ENDED);
    }

    return { userId: payload.sub, sessionId: payload.sid };
  }

  /** A sessão existe, não foi revogada, é do utilizador do token e a conta está activa. */
  private async sessionIsOpen(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = await this.sessions.findUsable(sessionId);

    return Boolean(
      session && session.userId === userId && session.user.isActive,
    );
  }

  private readToken(client: Socket): string | undefined {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const headers = client.handshake.headers as
      | { authorization?: unknown }
      | undefined;

    const raw =
      typeof auth?.token === 'string'
        ? auth.token
        : typeof headers?.authorization === 'string'
          ? headers.authorization
          : undefined;

    return raw?.replace('Bearer ', '').trim() || undefined;
  }

  private refuse(client: Socket, message: string) {
    client.emit('error', { message });
    client.disconnect(true);
  }

  /**
   * As recusas das regras de negócio (sem acesso, mensagem vazia, limite de
   * mensagens) vão para o cliente como estão. O resto fica no log e sai com
   * uma mensagem genérica, para não mostrar pormenores internos.
   */
  private toWsException(
    error: unknown,
    userId: string,
    conversationId: string,
  ): WsException {
    if (error instanceof HttpException) {
      this.logger.warn(
        `Mensagem recusada a ${userId} na conversa ${conversationId}: ${error.message}`,
      );
      return new WsException(error.message);
    }

    this.logger.error(
      `Falha ao enviar mensagem de ${userId} na conversa ${conversationId}`,
      error instanceof Error ? error.stack : String(error),
    );
    return new WsException(SEND_FAILED);
  }
}
