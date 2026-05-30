import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectVerificationDto {
  @ApiProperty({
    example: 'Foto do documento ilegível. Por favor reenvie em melhor qualidade.',
    description: 'Motivo da rejeição. Mostrado ao utilizador para que possa corrigir.',
    minLength: 5,
    maxLength: 500,
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
