import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateEquipmentDto {
  @ApiProperty({
    example: 'Camera Canon',
    description: 'Título do equipamento',
    minLength: 2,
    maxLength: 150,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  title!: string;

  @ApiProperty({
    example: 'Camera profissional para fotografia e vídeo.',
    description: 'Descrição detalhada do equipamento',
    minLength: 10,
    maxLength: 3000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  description!: string;

  @ApiProperty({
    example: 'ba6aae31-80be-46a2-9d91-6dcd19074d66',
    description: 'ID da categoria do equipamento',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  categoryId!: string;

  @ApiProperty({
    example: 1500,
    description: 'Preço por dia',
    minimum: 0.01,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerDay!: number;

  @ApiPropertyOptional({
    example: 8000,
    description: 'Preço por semana',
    minimum: 0.01,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerWeek?: number;

  @ApiPropertyOptional({
    example: 25000,
    description: 'Preço por mês',
    minimum: 0.01,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  pricePerMonth?: number;

  @ApiProperty({
    example: 5000,
    description: 'Valor do depósito de segurança',
    minimum: 0,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositAmount!: number;

  @ApiProperty({
    example: 'Maputo',
    description: 'Localização do equipamento',
    minLength: 2,
    maxLength: 255,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  location!: string;

  @ApiPropertyOptional({
    example: -25.9653,
    description: 'Latitude do equipamento',
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
    example: 32.5892,
    description: 'Longitude do equipamento',
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
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Indica se o owner disponibiliza operador',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  operatorAvailable?: boolean;

  @ApiPropertyOptional({
    enum: EquipmentCondition,
    example: EquipmentCondition.GOOD,
    description: 'Estado de conservação do equipamento',
    default: EquipmentCondition.GOOD,
  })
  @IsOptional()
  @IsEnum(EquipmentCondition)
  condition?: EquipmentCondition;
}
