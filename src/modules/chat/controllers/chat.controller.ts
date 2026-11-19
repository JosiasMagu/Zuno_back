import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  FindConversationsQueryDto,
  FindMessagesQueryDto,
  SendMessageDto,
  StartConversationDto,
} from '../dto/chat.dto';
import { ChatGateway } from '../gateways/chat.gateway';
import { ChatPresenter } from '../presenters/chat.presenter';
import { ChatService } from '../services/chat.service';

@ApiTags('Chat')
@Controller('chat')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly gateway: ChatGateway,
  ) {}

  // Iniciar conversa

  @Post('conversations')
  // O limite por conta está no serviço. Este é a rede por IP.
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'Iniciar conversa sobre um equipamento ou um serviço',
    description:
      'Quem pede fala com o dono do anúncio. Com clientId, é o dono do ' +
      'anúncio a falar com um cliente que tem uma reserva ou um pedido nele. ' +
      'Se a conversa já existe, a mensagem vai para ela. Há um limite diário ' +
      'de conversas novas por conta (429).',
  })
  @ApiBody({ type: StartConversationDto })
  @ApiResponse({ status: 201, description: 'Conversa iniciada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Anúncio não encontrado.' })
  @ApiResponse({ status: 429, description: 'Conversas ou mensagens a mais.' })
  async startConversation(
    @CurrentUser() user: { id: string },
    @Body() dto: StartConversationDto,
  ) {
    const result = await this.chatService.startConversation(user.id, dto);

    this.gateway.broadcastMessage(result.data.message);

    return result;
  }

  // Listar conversas do utilizador

  @Get('conversations')
  @ApiOperation({
    summary: 'Listar as minhas conversas',
    description:
      'As conversas do utilizador, da mais recente para a mais antiga, ' +
      'paginadas (30 por omissão, 100 no máximo). Cada uma traz unreadCount.',
  })
  @ApiResponse({ status: 200, description: 'Conversas obtidas com sucesso.' })
  findMyConversations(
    @CurrentUser() user: { id: string },
    @Query() query: FindConversationsQueryDto,
  ) {
    return this.chatService.findMyConversations(user.id, query);
  }

  // Detalhe de uma conversa + mensagens

  @Get('conversations/:id')
  @ApiOperation({
    summary: 'Obter conversa com mensagens',
    description:
      'Devolve os detalhes da conversa e as mensagens paginadas. ' +
      'Ficam lidas as mensagens do outro até à mais recente desta página.',
  })
  @ApiParam({ name: 'id', description: 'ID da conversa' })
  @ApiResponse({ status: 200, description: 'Conversa obtida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem acesso a esta conversa.' })
  @ApiResponse({ status: 404, description: 'Conversa não encontrada.' })
  findConversation(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Query() query: FindMessagesQueryDto,
  ) {
    return this.chatService.findConversation(user.id, id, query);
  }

  // Enviar mensagem

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Enviar mensagem',
    description:
      'É por aqui que a app envia. Cada conta tem um limite de mensagens ' +
      'por minuto (429). Quem estiver ligado pelo socket recebe-a também.',
  })
  @ApiParam({ name: 'id', description: 'ID da conversa' })
  @ApiBody({ type: SendMessageDto })
  @ApiResponse({ status: 201, description: 'Mensagem enviada com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem acesso a esta conversa.' })
  @ApiResponse({ status: 404, description: 'Conversa não encontrada.' })
  @ApiResponse({ status: 429, description: 'Mensagens a mais num minuto.' })
  async sendMessage(
    @CurrentUser() user: { id: string },
    @Param('id') conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.chatService.sendMessageToConversation(
      user.id,
      conversationId,
      dto.content,
    );
    const formatted = ChatPresenter.toMessage(message);

    this.gateway.broadcastMessage(formatted);

    return {
      message: 'Mensagem enviada com sucesso.',
      data: formatted,
    };
  }

  // Contar mensagens não lidas

  @Get('unread-count')
  @ApiOperation({
    summary: 'Contar mensagens não lidas',
    description:
      'Usado pelo front para o badge de notificação no ícone do chat.',
  })
  @ApiResponse({ status: 200, description: 'Contagem obtida com sucesso.' })
  countUnread(@CurrentUser() user: { id: string }) {
    return this.chatService.countUnread(user.id);
  }
}
