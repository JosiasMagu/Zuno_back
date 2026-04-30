import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectEquipmentDto {
  @ApiPropertyOptional({
    example: 'Fotos insuficientes ou de baixa qualidade.',
    description: 'Motivo da rejeição (opcional, mas recomendado)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
