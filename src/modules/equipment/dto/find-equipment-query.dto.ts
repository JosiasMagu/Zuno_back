import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
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
  // Para o MVP, NEAREST e aceite mas tratado como NEWEST internamente.
  // Quando geolocalizacao real for implementada, substituir o fallback
  // no buildOrderBy() do equipment.service.ts pela ordenacao por distancia.
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
    example: 'b1c4f9d0-1234-5678-90ab-cdef12345678',
    description: 'ID do proprietário (filtrar apenas itens deste provider)',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  ownerId?: string;

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
    example: '2026-09-15',
    description:
      'Início do intervalo desejado (ISO date). Combinado com `availableTo`, filtra equipamentos SEM bookings em conflito nesse intervalo.',
  })
  @IsOptional()
  @IsDateString()
  availableFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09-20',
    description:
      'Fim do intervalo desejado (ISO date). Exige `availableFrom`.',
  })
  @IsOptional()
  @IsDateString()
  availableTo?: string;

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
