import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateBookingStatusDto {
  @ApiPropertyOptional({
    example: 'Já não preciso do equipamento.',
    description: 'Motivo do cancelamento',
    minLength: 2,
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}