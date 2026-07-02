import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeReason } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ClaimDepositDto {
  @ApiProperty({ description: 'ID da reserva de equipamento (ACTIVE).' })
  @IsString()
  @IsNotEmpty({ message: 'O bookingId é obrigatório.' })
  bookingId!: string;

  @ApiPropertyOptional({
    enum: DisputeReason,
    default: DisputeReason.DAMAGED,
    description: 'Motivo da reclamação do depósito.',
  })
  @IsOptional()
  @IsEnum(DisputeReason)
  reason?: DisputeReason;

  @ApiProperty({
    description: 'Descrição do dano/problema encontrado na devolução.',
    example: 'A betoneira foi devolvida com o motor queimado.',
  })
  @IsString()
  @MinLength(20, { message: 'A descrição deve ter pelo menos 20 caracteres.' })
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional({
    description: 'URLs de fotos que evidenciam o dano.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({}, { each: true, message: 'Cada evidência deve ser um URL válido.' })
  evidenceUrls?: string[];
}
