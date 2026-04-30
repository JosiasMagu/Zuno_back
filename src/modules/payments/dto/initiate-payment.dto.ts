import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class InitiatePaymentDto {
  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.MPESA,
    description: 'Método de pagamento',
  })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;
}