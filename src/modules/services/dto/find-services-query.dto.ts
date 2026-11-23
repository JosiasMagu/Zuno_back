import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

import {
  MAX_SEARCH_LENGTH,
  PaginationQueryDto,
} from '../../../common/dto/pagination-query.dto';
import { toOptionalBoolean } from '../../../common/dto/transforms';

export enum ServiceSortBy {
  RELEVANT = 'relevant',
  LOWEST_PRICE = 'lowest_price',
  HIGHEST_PRICE = 'highest_price',
  NEAREST = 'nearest',
  NEWEST = 'newest',
}

function toOptionalTrimmedString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export class FindServicesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'electricista' })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'electricidade' })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  categorySlug?: string;

  @ApiPropertyOptional({ example: 'Maputo' })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Filtrar apenas serviços que aceitam pedidos urgentes',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  isUrgent?: boolean;

  @ApiPropertyOptional({
    enum: ServiceSortBy,
    example: ServiceSortBy.NEWEST,
    description:
      '"nearest" aceite mas usa "newest" como fallback no MVP (geolocalização real é backlog).',
  })
  @IsOptional()
  @IsEnum(ServiceSortBy)
  sortBy?: ServiceSortBy = ServiceSortBy.NEWEST;
}
