import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SavePushTokenDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxx]' })
  @IsString()
  @MinLength(10)
  token!: string;
}