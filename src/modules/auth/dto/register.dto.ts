import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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
    description: 'Número de telefone do utilizador',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({
    example: 'zuno@test.com',
    description: 'Email do utilizador',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: '123456',
    description: 'Palavra-passe com no mínimo 6 caracteres',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;
}
