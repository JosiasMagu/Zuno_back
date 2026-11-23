import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
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
    example: '',
    description:
      'Vazio tira a foto de perfil. Para a pôr usa-se POST /users/me/avatar. Um endereço só é aceite se for do Cloudinary da plataforma.',
    maxLength: 500,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((dto: UpdateUserDto) => dto.avatarUrl !== '')
  @MaxLength(500)
  @IsProjectMediaUrl()
  avatarUrl?: string;
}
