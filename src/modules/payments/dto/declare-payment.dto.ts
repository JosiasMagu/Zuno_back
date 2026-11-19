import { ApiProperty } from '@nestjs/swagger';

import { IsMzPhone } from '../../auth/dto/account-fields';
import { IsMpesaReference } from './mpesa-reference';

/** O que o cliente diz depois de pagar por M-Pesa. */
export class DeclarePaymentDto {
  @ApiProperty({
    example: 'CHK7H3ABCD',
    description: 'Referência do SMS de confirmação do M-Pesa.',
  })
  @IsMpesaReference()
  mpesaReference!: string;

  @ApiProperty({
    example: '841234567',
    description: 'Número de onde o pagamento foi feito.',
  })
  @IsMzPhone()
  payerMsisdn!: string;
}
