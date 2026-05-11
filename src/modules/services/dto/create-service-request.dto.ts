import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateServiceRequestDto {
  @ApiProperty({ description: 'ID do serviço-alvo' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  serviceId: string;

  @ApiProperty({
    example: 'Preciso de reparação eléctrica urgente em casa.',
    minLength: 10,
    maxLength: 3000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  description: string;

  @ApiPropertyOptional({
    example: '2026-05-15T10:00:00Z',
    description: 'Data preferida para execução (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  preferredDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isUrgent?: boolean;

  @ApiProperty({ example: 'Av. Eduardo Mondlane, 123, Maputo' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  address: string;

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
    example: '2026-05-20T23:59:59Z',
    description:
      'Quando o pedido expira (se nenhum orçamento for aceite). Default: 7 dias.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
