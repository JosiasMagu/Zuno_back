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

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

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

function toOptionalBoolean(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class FindServicesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'electricista' })
  @IsOptional()
  @Transform(({ value }) => toOptionalTrimmedString(value))
  @IsString()
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
