import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';

export class RequestPhoneVerificationDto {
  @ApiProperty({ example: '+258840000000' })
  @IsString()
  @IsPhoneNumber('MZ')
  phone!: string;
}

export class ConfirmPhoneVerificationDto {
  @ApiProperty({ example: '+258840000000' })
  @IsString()
  @IsPhoneNumber('MZ')
  phone!: string;

  @ApiProperty({ example: '123456', description: 'Codigo de 6 digitos' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: '+258840000000' })
  @IsString()
  @IsPhoneNumber('MZ')
  phone!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: '+258840000000' })
  @IsString()
  @IsPhoneNumber('MZ')
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({
    example: 'NovaPass@2026',
    description:
      'Minimo 10 caracteres. Deve incluir maiusculas, minusculas e digitos.',
  })
  @IsString()
  @MinLength(10)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'A password deve conter pelo menos uma maiuscula, uma minuscula e um digito.',
  })
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({
    example: 'NovaPass@2026',
    description:
      'Minimo 10 caracteres. Deve incluir maiusculas, minusculas e digitos.',
  })
  @IsString()
  @MinLength(10)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'A password deve conter pelo menos uma maiuscula, uma minuscula e um digito.',
  })
  newPassword!: string;
}
