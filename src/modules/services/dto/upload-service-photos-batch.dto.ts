import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';

export class UploadServicePhotosBatchDto {
  @ApiProperty({ description: 'ID do serviço alvo do upload em batch' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  serviceId: string;
}
