import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

const DOCUMENT_ID =
  'Identificador devolvido por `POST /users/me/verification/documents`';

export class SubmitVerificationDto {
  @ApiProperty({
    enum: DocumentType,
    example: DocumentType.BI,
    description: 'Tipo de documento de identificação submetido.',
  })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({
    example: 'zuno/kyc/<userId>/k3j2h1',
    description: `${DOCUMENT_ID} para a frente do documento.`,
  })
  @IsString()
  @MaxLength(200)
  documentFrontId!: string;

  @ApiPropertyOptional({
    example: 'zuno/kyc/<userId>/p9o8i7',
    description: `${DOCUMENT_ID} para o verso (dispensável no passaporte).`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  documentBackId?: string;

  @ApiProperty({
    example: 'zuno/kyc/<userId>/z1x2c3',
    description: `${DOCUMENT_ID} para a selfie com o documento na mão.`,
  })
  @IsString()
  @MaxLength(200)
  selfieId!: string;
}
