import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ExecutePayoutDto {
  @ApiProperty({
    description: 'Referência da transferência M-Pesa executada.',
    example: 'QGH7RT51XK',
  })
  @IsString()
  @IsNotEmpty({ message: 'A referência M-Pesa é obrigatória.' })
  @MaxLength(64)
  mpesaReference!: string;

  @ApiPropertyOptional({
    description:
      'Número M-Pesa de destino, caso seja diferente do registado no perfil do destinatário.',
    example: '+258841234567',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  msisdn?: string;
}
