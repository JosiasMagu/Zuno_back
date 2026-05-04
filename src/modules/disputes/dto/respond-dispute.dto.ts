import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RespondDisputeDto {
  @ApiProperty({
    example: 'O equipamento foi enviado em boas condições.',
    description: 'Resposta do owner à disputa',
    minLength: 2,
    maxLength: 2000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  ownerResponse: string;
}
