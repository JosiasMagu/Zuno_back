import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { IsMzPhone } from '../../auth/dto/account-fields';

export class ChangePayoutNumberDto {
  @ApiProperty({
    example: '+258841234567',
    description:
      'Número M-Pesa onde a conta passa a receber pagamentos e reembolsos.',
  })
  @IsMzPhone()
  payoutMsisdn!: string;

  @ApiProperty({ description: 'Password actual da conta.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;
}
