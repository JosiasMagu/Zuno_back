import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReviewAuthorRole } from '@prisma/client';

export class CreateReviewDto {
  @ApiPropertyOptional({
    description:
      'ID da reserva de equipamento. Obrigatório se não fornecer serviceBookingId.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description:
      'ID da reserva de serviço. Obrigatório se não fornecer bookingId.',
  })
  @IsOptional()
  @IsUUID()
  serviceBookingId?: string;

  @ApiProperty({
    enum: ReviewAuthorRole,
    example: ReviewAuthorRole.CLIENT,
    description:
      'Papel do autor: CLIENT (avalia equipment + owner) ou OWNER (avalia cliente)',
  })
  @IsEnum(ReviewAuthorRole)
  authorRole: ReviewAuthorRole;

  @ApiProperty({
    example: 5,
    description: 'Classificação de 1 a 5 estrelas',
    minimum: 1,
    maximum: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({
    example: 'Equipamento em excelente estado, entrega pontual.',
    description: 'Comentário opcional (máx. 1000 caracteres)',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
