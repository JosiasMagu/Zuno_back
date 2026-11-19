import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

import { IsMzPhone } from '../../auth/dto/account-fields';
import { IsMpesaReference } from './mpesa-reference';

export class ExecutePayoutDto {
  @ApiProperty({
    description: 'Referência da transferência M-Pesa executada.',
    example: 'QGH7RT51XK',
  })
  @IsMpesaReference()
  mpesaReference!: string;

  @ApiPropertyOptional({
    description:
      'Número M-Pesa de destino, caso seja diferente do registado no perfil do destinatário.',
    example: '+258841234567',
  })
  @IsOptional()
  @IsMzPhone()
  msisdn?: string;
}
