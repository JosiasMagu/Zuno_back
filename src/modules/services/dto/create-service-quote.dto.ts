import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateServiceQuoteDto {
  @ApiProperty({
    example: 4500,
    description: 'Valor base proposto (MZN). Sem majoração de urgência.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({
    example: 1350,
    description:
      'Valor adicional cobrado se o pedido for urgente (MZN). Obrigatório se request.isUrgent=true.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  urgentSurcharge?: number;

  @ApiProperty({
    example: 5850,
    description:
      'Total final cobrado (amount + urgentSurcharge se aplicável). Deve coincidir com a soma.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  totalAmount: number;

  @ApiProperty({
    example: 3,
    description: 'Prazo estimado de execução em dias',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  estimatedDays: number;

  @ApiPropertyOptional({
    example: 'Inclui material básico. Posso começar amanhã.',
    maxLength: 2000,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  message?: string;

  @ApiPropertyOptional({
    example: '2026-05-12T23:59:59Z',
    description: 'Quando o orçamento expira (default: 48h).',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
