import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// Iniciar conversa

export class StartConversationDto {
  @ApiPropertyOptional({
    description: 'ID do equipamento. Obrigatório se não fornecer serviceId.',
  })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @ApiPropertyOptional({
    description: 'ID do serviço. Obrigatório se não fornecer equipmentId.',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  firstMessage: string;
}

// Enviar mensagem (via REST - fallback)

export class SendMessageDto {
  @ApiProperty({
    example: 'Sim, está disponível! Posso entregar na segunda-feira.',
    description: 'Conteúdo da mensagem (mín. 1, máx. 1000 caracteres)',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  content: string;
}

// Query de mensagens

export class FindMessagesQueryDto {
  @ApiPropertyOptional({ example: 1, description: 'Página', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 30,
    description: 'Mensagens por página',
    default: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 30;
}

// Payload WebSocket - cliente envia ao servidor

export class WsMessagePayload {
  @IsUUID()
  conversationId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  content: string;
}
