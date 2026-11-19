import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { PASSWORD_MIN_LENGTH } from '../auth.policy';
import { IsMzPhone, IsNewPassword } from './account-fields';

export class RegisterDto {
  @ApiProperty({
    example: 'Daniel Anderone',
    description: 'Nome completo do utilizador',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: '841234567',
    description:
      'Telemóvel moçambicano, com ou sem o indicativo +258. Fica guardado em E.164.',
  })
  @IsMzPhone()
  phone: string;

  @ApiPropertyOptional({
    example: 'zuno@test.com',
    description: 'Email do utilizador',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'gerador-amarelo-2026',
    description: `Palavra-passe com pelo menos ${PASSWORD_MIN_LENGTH} caracteres`,
    minLength: PASSWORD_MIN_LENGTH,
  })
  @IsNewPassword()
  password: string;
}
