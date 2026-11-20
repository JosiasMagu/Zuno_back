import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ReviewAuthorRole } from '@prisma/client';

import { toAuthorRole } from './author-role';

export class FindReviewsQueryDto {
  @ApiPropertyOptional({ example: 1, description: 'Página', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 10,
    description: 'Itens por página',
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  @ApiPropertyOptional({
    enum: ReviewAuthorRole,
    description:
      'Filtrar por tipo de avaliação. OWNER, o nome antigo de PROVIDER, ainda é aceite.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toAuthorRole(value))
  @IsEnum(ReviewAuthorRole)
  authorRole?: ReviewAuthorRole;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-...',
    description: 'Filtrar avaliações de um booking específico',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}
