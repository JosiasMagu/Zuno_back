import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class UploadServicePhotoDto {
  @ApiProperty({ description: 'ID do serviço alvo do upload' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  serviceId: string;

  @ApiProperty({
    required: false,
    description: 'Se true, esta foto torna-se a principal.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @Type(() => Boolean)
  @IsBoolean()
  isPrimary?: boolean;
}
