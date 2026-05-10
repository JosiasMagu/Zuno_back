import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DisputeReason } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDisputeDto {
  @ApiPropertyOptional({
    description:
      'ID da reserva de equipamento. Obrigatório se não fornecer serviceBookingId.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description:
      'ID da reserva de serviço. Obrigatório se não fornecer bookingId.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  serviceBookingId?: string;

  @ApiProperty({ description: 'ID do pagamento associado' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  paymentId: string;

  @ApiProperty({ enum: DisputeReason, example: DisputeReason.DAMAGED })
  @IsEnum(DisputeReason)
  reason: DisputeReason;

  @ApiProperty({ minLength: 5, maxLength: 2000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  description: string;
}
