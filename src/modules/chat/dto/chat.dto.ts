import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Quantas mensagens ou conversas cabem numa página. */
const MAX_PAGE_SIZE = 100;

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

  @ApiPropertyOptional({
    description:
      'Só para o dono do anúncio: o cliente com quem quer falar. Tem de ser alguém com uma reserva ou um pedido nesse anúncio. Sem este campo, quem pede fala com o dono do anúncio.',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  firstMessage: string;
}

// Enviar mensagem (via REST)

export class SendMessageDto {
  @ApiProperty({
    example: 'Sim, está disponível! Posso entregar na segunda-feira.',
    description: 'Conteúdo da mensagem (mín. 1, máx. 1000 caracteres)',
    minLength: 1,
    maxLength: 1000,
  })
  @Transform(trimmed)
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
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 30;
}

// Query da lista de conversas

export class FindConversationsQueryDto {
  @ApiPropertyOptional({ example: 1, description: 'Página', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 30,
    description: 'Conversas por página',
    default: 30,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 30;
}
