import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DisputeReason } from '@prisma/client';
import {
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDisputeDto {
  @ApiProperty({
    example: '89619d24-e335-4cfb-82b0-75b8ed739195',
    description: 'ID da reserva',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  bookingId: string;

  @ApiProperty({
    example: 'e19977c4-826a-41c0-8711-58b36b3b0750',
    description: 'ID do pagamento',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  paymentId: string;

  @ApiProperty({
    enum: DisputeReason,
    example: DisputeReason.DAMAGED,
    description: 'Motivo da disputa',
  })
  @IsEnum(DisputeReason)
  reason: DisputeReason;

  @ApiProperty({
    example: 'O equipamento chegou com defeito.',
    description: 'Descrição detalhada da disputa',
    minLength: 5,
    maxLength: 2000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  description: string;
}