import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendUserDto {
  @ApiPropertyOptional({
    example: 'Violação dos termos de serviço — múltiplas reservas falsas.',
    description: 'Motivo da suspensão (opcional, vai para o audit log).',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
