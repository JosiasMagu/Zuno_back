import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FailPayoutDto {
  @ApiProperty({
    description: 'Motivo da falha na execução da transferência.',
    example: 'Número M-Pesa inválido.',
  })
  @IsString()
  @IsNotEmpty({ message: 'O motivo da falha é obrigatório.' })
  @MaxLength(500)
  reason!: string;
}
