import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'Daniel Andrade',
    description: 'Nome do utilizador',
    minLength: 2,
    maxLength: 120,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: 'daniel@example.com',
    description: 'Email do utilizador',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: 'Programador backend e entusiasta de arquitetura de software.',
    description: 'Biografia do utilizador',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/avatar.png',
    description: 'URL do avatar do utilizador',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({
    example: '+258841234567',
    description:
      'Número M-Pesa para receber payouts (reembolsos e pagamentos de aluguer).',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?258(8[2-7])\d{7}$/, {
    message:
      'O número de recebimento deve ser um número moçambicano válido (ex.: +258841234567).',
  })
  payoutMsisdn?: string;
}
