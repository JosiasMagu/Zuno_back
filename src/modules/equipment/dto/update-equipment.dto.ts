import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EquipmentCondition } from '@prisma/client';

export class UpdateEquipmentDto {
  @ApiPropertyOptional({
    example: 'Camera Canon Mark II',
    description: 'Novo título do equipamento',
    minLength: 2,
    maxLength: 150,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional({
    example: 'Descrição atualizada do equipamento.',
    description: 'Nova descrição do equipamento',
    minLength: 10,
    maxLength: 3000,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  description?: string;

  @ApiPropertyOptional({
    example: 'ba6aae31-80be-46a2-9d91-6dcd19074d66',
    description: 'Novo ID da categoria',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: 1800,
    description: 'Novo preço por dia',
    minimum: 0.01,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerDay?: number;

  @ApiPropertyOptional({
    example: 9000,
    description: 'Novo preço por semana',
    minimum: 0.01,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerWeek?: number;

  @ApiPropertyOptional({
    example: 26000,
    description: 'Novo preço por mês',
    minimum: 0.01,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerMonth?: number;

  @ApiPropertyOptional({
    example: 6000,
    description: 'Novo valor do depósito',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  @ApiPropertyOptional({
    example: 'Beira',
    description: 'Nova localização do equipamento',
    minLength: 2,
    maxLength: 255,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  location?: string;

  @ApiPropertyOptional({
    example: -19.8436,
    description: 'Nova latitude',
    minimum: -90,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({
    example: 34.8389,
    description: 'Nova longitude',
    minimum: -180,
    maximum: 180,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Indica se o owner disponibiliza entrega',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Indica se o owner disponibiliza operador',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  operatorAvailable?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Indica se o equipamento está disponível para novas reservas',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  availableNow?: boolean;

  @ApiPropertyOptional({
    enum: EquipmentCondition,
    example: EquipmentCondition.EXCELLENT,
    description: 'Novo estado de conservação do equipamento',
  })
  @IsOptional()
  @IsEnum(EquipmentCondition)
  condition?: EquipmentCondition;
}
