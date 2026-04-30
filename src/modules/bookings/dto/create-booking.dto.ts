import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBookingDto {
  @ApiProperty({
    example: 'fc9d471c-e151-433b-8248-8da83844ea2e',
    description: 'ID do equipamento a reservar',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  equipmentId: string;

  @ApiProperty({
    example: '2026-04-25',
    description: 'Data inicial da reserva',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({
    example: '2026-04-27',
    description: 'Data final da reserva',
  })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({
    example: 'Maputo, Bairro Central',
    description: 'Endereço de entrega',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  deliveryAddress?: string;

  @ApiPropertyOptional({
    example: 'Preciso do equipamento em bom estado.',
    description: 'Observação do cliente',
    minLength: 2,
    maxLength: 1000,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  clientNote?: string;
}