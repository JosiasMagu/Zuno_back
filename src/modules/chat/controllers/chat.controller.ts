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
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  FindMessagesQueryDto,
  SendMessageDto,
  StartConversationDto,
} from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';

@ApiTags('Chat')
@Controller('chat')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // Iniciar conversa (CLIENT)

  @Post('conversations')

  @ApiOperation({
    summary: 'Iniciar conversa sobre um equipamento',
    description:
      'Só CLIENTs podem iniciar. Se já existe conversa com o mesmo owner ' +
      'sobre o mesmo equipment, envia a mensagem na conversa existente.',
  })
  @ApiBody({ type: StartConversationDto })
  @ApiResponse({ status: 201, description: 'Conversa iniciada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  startConversation(
    @CurrentUser() user: { id: string },
    @Body() dto: StartConversationDto,
  ) {
    return this.chatService.startConversation(user.id, dto);
  }

  // Listar conversas do utilizador

  @Get('conversations')
  @ApiOperation({
    summary: 'Listar as minhas conversas',
    description:
      'Devolve todas as conversas do utilizador ordenadas pela última mensagem.',
  })
  @ApiResponse({ status: 200, description: 'Conversas obtidas com sucesso.' })
  findMyConversations(@CurrentUser() user: { id: string }) {
    return this.chatService.findMyConversations(user.id);
  }

  // Detalhe de uma conversa + mensagens

  @Get('conversations/:id')
  @ApiOperation({
    summary: 'Obter conversa com mensagens',
    description:
      'Devolve os detalhes da conversa e as mensagens paginadas. ' +
      'Marca automaticamente as mensagens do outro como lidas.',
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

  // Enviar mensagem via REST (fallback quando WebSocket nao disponivel)

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Enviar mensagem via REST (fallback)',
    description:
      'Alternativa ao WebSocket para ambientes sem suporte a sockets. ' +
      'O front deve preferir o WebSocket para tempo real.',
  })
  @ApiParam({ name: 'id', description: 'ID da conversa' })
  @ApiBody({ type: SendMessageDto })
  @ApiResponse({ status: 201, description: 'Mensagem enviada com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem acesso a esta conversa.' })
  @ApiResponse({ status: 404, description: 'Conversa não encontrada.' })
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

    return {
      message: 'Mensagem enviada com sucesso.',
      data: message,
    };
  }

  // Contar mensagens nao lidas

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
