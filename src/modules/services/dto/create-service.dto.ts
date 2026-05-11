import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServicePricingType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateServiceDto {
  @ApiProperty({
    example: 'Reparação eléctrica residencial',
    minLength: 2,
    maxLength: 150,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  title: string;

  @ApiProperty({
    example:
      'Diagnóstico, reparação e instalação de sistemas eléctricos em residências.',
    minLength: 10,
    maxLength: 3000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  description: string;

  @ApiProperty({ example: 'a1b2c3d4-...', description: 'ID da categoria' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  categoryId: string;

  @ApiProperty({ example: 1500, description: 'Preço base de referência (MZN)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  basePrice: number;

  @ApiPropertyOptional({
    enum: ServicePricingType,
    example: ServicePricingType.FIXED,
    default: ServicePricingType.FIXED,
  })
  @IsOptional()
  @IsEnum(ServicePricingType)
  pricingType?: ServicePricingType;

  @ApiPropertyOptional({
    example: 4,
    description: 'Horas estimadas (obrigatório se pricingType=HOURLY)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  estimatedHours?: number;

  @ApiProperty({ example: 'Maputo' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  location: string;

  @ApiPropertyOptional({ example: -25.9653 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 32.5892 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Aceita pedidos com urgência',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  acceptsUrgent?: boolean;

  @ApiPropertyOptional({
    example: 30,
    description:
      'Majoração percentual cobrada se o pedido for urgente (ex. 30 = +30%). Obrigatório se acceptsUrgent=true.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999.99)
  urgentSurcharge?: number;
}
