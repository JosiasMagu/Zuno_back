import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: '841234567',
    description: 'Número de telefone do utilizador',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    example: '123456',
    description: 'Palavra-passe do utilizador',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;
}
