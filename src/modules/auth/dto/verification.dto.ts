import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

import { PASSWORD_MIN_LENGTH } from '../auth.policy';
import { IsMzPhone, IsNewPassword } from './account-fields';

const NEW_PASSWORD_DESCRIPTION = `Pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;

export class RequestPhoneVerificationDto {
  @ApiProperty({ example: '+258840000000' })
  @IsMzPhone()
  phone!: string;
}

export class ConfirmPhoneVerificationDto {
  @ApiProperty({ example: '+258840000000' })
  @IsMzPhone()
  phone!: string;

  @ApiProperty({ example: '123456', description: 'Codigo de 6 digitos' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: '+258840000000' })
  @IsMzPhone()
  phone!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: '+258840000000' })
  @IsMzPhone()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({
    example: 'gerador-amarelo-2026',
    description: NEW_PASSWORD_DESCRIPTION,
  })
  @IsNewPassword()
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({
    example: 'gerador-amarelo-2026',
    description: NEW_PASSWORD_DESCRIPTION,
  })
  @IsNewPassword()
  newPassword!: string;
}
