import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { toE164WhenPossible } from './account-fields';

export class LoginDto {
  // Não se exige aqui um telemóvel válido: uma conta antiga cujo telefone não
  // se consiga normalizar continua a poder entrar com o que tem gravado.
  @ApiProperty({
    example: '841234567',
    description: 'Telemóvel da conta, com ou sem o indicativo +258',
  })
  @Transform(({ value }) => toE164WhenPossible(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone: string;

  @ApiProperty({ description: 'Palavra-passe da conta' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
