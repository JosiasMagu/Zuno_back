import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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

import { toAuthorRole } from './author-role';

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
      'Papel do autor: CLIENT (avalia o anúncio e quem o publicou) ou PROVIDER (avalia o cliente). OWNER, o nome antigo de PROVIDER, ainda é aceite.',
  })
  @Transform(({ value }: { value: unknown }) => toAuthorRole(value))
  @IsEnum(ReviewAuthorRole)
  authorRole!: ReviewAuthorRole;

  @ApiProperty({
    example: 5,
    description: 'Classificação de 1 a 5 estrelas',
    minimum: 1,
    maximum: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

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
