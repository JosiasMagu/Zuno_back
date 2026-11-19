import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { IsEvidenceUrls } from './evidence-urls';

/** O que a outra parte da reserva responde a uma disputa. */
export class RespondDisputeDto {
  @ApiProperty({
    example:
      'O equipamento foi entregue em boas condições, como mostram as fotos.',
    description: 'A versão de quem responde.',
    minLength: 2,
    maxLength: 2000,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  response!: string;

  @ApiPropertyOptional({
    description:
      'Fotos de prova de quem responde, já carregadas em POST /disputes/upload-evidence.',
    type: [String],
  })
  @IsEvidenceUrls()
  evidenceUrls?: string[];
}
