import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: '0f8b6c1e-5d2a-4c7e-9b1f-3a2d4e5f6a7b.pX3v...',
    description: 'Refresh token devolvido no login ou na última renovação',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
