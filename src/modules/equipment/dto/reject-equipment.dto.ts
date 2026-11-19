import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectEquipmentDto {
  @ApiPropertyOptional({
    example: 'Fotos insuficientes ou de baixa qualidade.',
    description: 'Motivo da rejeição (opcional, mas recomendado)',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  reason?: string;
}
