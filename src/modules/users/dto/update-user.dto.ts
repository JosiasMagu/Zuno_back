import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { IsProjectMediaUrl } from '../../../shared/cloudinary/project-media-url';

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
    example: 'https://res.cloudinary.com/<cloud>/image/upload/avatar.jpg',
    description:
      'Foto de perfil. Tem de estar no Cloudinary da plataforma: um link de fora é recusado.',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500)
  @IsProjectMediaUrl()
  avatarUrl?: string;
}
