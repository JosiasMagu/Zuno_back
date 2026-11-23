import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { EquipmentCondition } from '@prisma/client';
import {
  MAX_SEARCH_LENGTH,
  PaginationQueryDto,
} from '../../../common/dto/pagination-query.dto';
import { toOptionalBoolean } from '../../../common/dto/transforms';

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

export class FindEquipmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'gerador',
    description:
      'Termo de busca textual (título, descrição, localização ou categoria)',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
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
    deprecated: true,
    description:
      'Nome antigo de `deliveryAvailable`, que a app ainda envia. Quando chegam os dois, vale `deliveryAvailable`.',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  deliveryIncluded?: boolean;

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
      'Primeiro dia do período desejado (ISO date). Com `availableTo`, devolve só os equipamentos com pelo menos uma unidade livre nesse período, contado em dias inteiros como nas reservas.',
  })
  @IsOptional()
  @IsDateString()
  availableFrom?: string;

  @ApiPropertyOptional({
    example: '2026-09-20',
    description:
      'Dia em que o período acaba (ISO date); esse dia já não faz parte dele. Exige `availableFrom`.',
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
