import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { EquipmentCondition } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export enum EquipmentSortBy {
  RELEVANT = 'relevant',
  LOWEST_PRICE = 'lowest_price',
  HIGHEST_PRICE = 'highest_price',
  // Para o MVP, NEAREST é aceite mas tratado como NEWEST internamente.
  // Quando geolocalização real for implementada, substituir o fallback
  // no buildOrderBy() do equipment.service.ts pela ordenação por distância.
  NEAREST = 'nearest',
  NEWEST = 'newest',
}

function toOptionalTrimmedString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function toOptionalBoolean(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class FindEquipmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'gerador',
    description:
      'Termo de busca textual (título, descrição, localização ou categoria)',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    example: 'ba6aae31-80be-46a2-9d91-6dcd19074d66',
    description: 'ID da categoria',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    example: 'geradores',
    description: 'Slug da categoria (alternativa ao categoryId)',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  categorySlug?: string;

  @ApiPropertyOptional({
    example: 'Maputo',
    description: 'Filtrar por localização (busca parcial)',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  location?: string;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Preço mínimo por dia (MZN)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({
    example: 5000,
    description: 'Preço máximo por dia (MZN)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Filtrar apenas equipamentos com entrega disponível',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Filtrar apenas equipamentos com operador disponível',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  operatorAvailable?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Filtrar apenas equipamentos disponíveis agora',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  onlyAvailableNow?: boolean;

  @ApiPropertyOptional({
    enum: EquipmentCondition,
    example: EquipmentCondition.GOOD,
    description: 'Filtrar por estado de conservação do equipamento',
  })
  @IsOptional()
  @IsEnum(EquipmentCondition)
  condition?: EquipmentCondition;

  @ApiPropertyOptional({
    enum: EquipmentSortBy,
    example: EquipmentSortBy.NEWEST,
    description:
      'Critério de ordenação. "nearest" aceite (requer geolocalização futura — usa "newest" como fallback no MVP).',
  })
  @IsOptional()
  @IsEnum(EquipmentSortBy)
  sortBy?: EquipmentSortBy = EquipmentSortBy.NEWEST;
}
