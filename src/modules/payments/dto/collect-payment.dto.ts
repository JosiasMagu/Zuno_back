import { ApiProperty } from '@nestjs/swagger';

import { IsMzPhone } from '../../auth/dto/account-fields';

/** O cliente pede a cobrança no telemóvel. */
export class CollectPaymentDto {
  @ApiProperty({
    example: '+258841234567',
    description:
      'O número M-Pesa que vai receber o pedido de pagamento. Fica guardado como número pagador.',
  })
  @IsMzPhone()
  msisdn!: string;
}
