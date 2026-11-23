import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

import { toOptionalBoolean } from '../../../common/dto/transforms';

export class UploadServicePhotoDto {
  @ApiProperty({ description: 'ID do serviço alvo do upload' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    required: false,
    description: 'Se true, esta foto torna-se a principal.',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  isPrimary?: boolean;
}
