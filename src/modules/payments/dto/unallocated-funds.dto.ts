import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UnallocatedStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsMzPhone } from '../../auth/dto/account-fields';
import { IsMpesaReference } from './mpesa-reference';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Uma linha do extracto que não fecha nenhum pagamento. */
export class RegisterUnallocatedDto {
  @ApiProperty({
    example: 'AB12CD34EF',
    description: 'Referência M-Pesa da entrada.',
  })
  @IsMpesaReference()
  mpesaReference!: string;

  @ApiProperty({ example: 9000, description: 'O valor que entrou.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: '+258841234567', description: 'O número que pagou.' })
  @IsMzPhone()
  payerMsisdn!: string;

  @ApiPropertyOptional({
    description:
      'O pagamento a que o dinheiro parece destinar-se, quando se sabe.',
  })
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A devolução feita à mão, por M-Pesa. */
export class MarkUnallocatedReturnedDto {
  @ApiProperty({
    example: 'ZX98YW76VU',
    description: 'Referência M-Pesa da devolução.',
  })
  @IsMpesaReference()
  returnReference!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class FindUnallocatedQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UnallocatedStatus })
  @IsOptional()
  @IsEnum(UnallocatedStatus)
  status?: UnallocatedStatus;
}
