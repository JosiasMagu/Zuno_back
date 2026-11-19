import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive } from 'class-validator';

import { IsMzPhone } from '../../auth/dto/account-fields';
import { IsMpesaReference } from './mpesa-reference';

/**
 * O que o admin lê no extracto M-Pesa antes de dar o dinheiro como recebido.
 * Sem estes três dados não há como provar depois que o pagamento entrou.
 */
export class MarkPaymentHeldDto {
  @ApiProperty({
    example: 'CHK7H3ABCD',
    description: 'Referência da transacção M-Pesa, como aparece no extracto.',
  })
  @IsMpesaReference()
  mpesaReference!: string;

  @ApiProperty({
    example: 9950,
    description:
      'Valor recebido, em MZN. Tem de ser igual ao total do pagamento.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  receivedAmount!: number;

  @ApiProperty({
    example: '+258841234567',
    description: 'Número de onde veio o pagamento.',
  })
  @IsMzPhone()
  payerMsisdn!: string;
}
