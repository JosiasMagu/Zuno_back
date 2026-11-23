import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';
import { IsEnum, IsOptional, MaxLength } from 'class-validator';

import { IsProjectMediaUrl } from '../../../shared/cloudinary/project-media-url';

export class SubmitVerificationDto {
  @ApiProperty({
    enum: DocumentType,
    example: DocumentType.BI,
    description: 'Tipo de documento de identificação submetido.',
  })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({
    example:
      'https://res.cloudinary.com/dojumw0as/image/upload/.../bi-front.jpg',
    description: 'URL Cloudinary da foto do FRENTE do documento.',
  })
  @IsProjectMediaUrl()
  @MaxLength(500)
  documentFrontUrl!: string;

  @ApiPropertyOptional({
    example:
      'https://res.cloudinary.com/dojumw0as/image/upload/.../bi-back.jpg',
    description:
      'URL Cloudinary do VERSO do documento (opcional para Passaporte).',
  })
  @IsOptional()
  @IsProjectMediaUrl()
  @MaxLength(500)
  documentBackUrl?: string;

  @ApiProperty({
    example: 'https://res.cloudinary.com/dojumw0as/image/upload/.../selfie.jpg',
    description: 'URL Cloudinary da selfie segurando o documento.',
  })
  @IsProjectMediaUrl()
  @MaxLength(500)
  selfieUrl!: string;
}
