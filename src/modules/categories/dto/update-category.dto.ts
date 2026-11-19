import { ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * O campo veio no pedido. Com `@IsOptional()` um null passava sem validação
 * e rebentava mais à frente, por isso aqui só o que não veio é que se salta.
 */
const wasSent = (_dto: unknown, value: unknown) => value !== undefined;

/** O campo veio com um valor. Um null explícito quer dizer «tirar». */
const hasValue = (_dto: unknown, value: unknown) =>
  value !== undefined && value !== null;

export class UpdateCategoryDto {
  @ApiPropertyOptional({
    example: 'Fotografia Profissional',
    description: 'Novo nome da categoria',
    minLength: 2,
    maxLength: 120,
  })
  @ValidateIf(wasSent)
  @Transform(trimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/icon.png',
    description: 'Nova URL do ícone da categoria. null tira o ícone.',
    maxLength: 500,
    nullable: true,
  })
  @ValidateIf(hasValue)
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  iconUrl?: string | null;

  @ApiPropertyOptional({
    example: 'ba6aae31-80be-46a2-9d91-6dcd19074d66',
    description:
      'Novo ID da categoria pai. null tira a categoria de debaixo do pai.',
    nullable: true,
  })
  @ValidateIf(hasValue)
  @Transform(trimmed)
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({
    enum: CategoryKind,
    description:
      'Para que serve a categoria. Só muda se couber no que ela já tem: anúncios, subcategorias e a categoria pai.',
  })
  @ValidateIf(wasSent)
  @IsEnum(CategoryKind)
  kind?: CategoryKind;

  @ApiPropertyOptional({
    example: true,
    description:
      'false desactiva a categoria, com as mesmas condições de DELETE. true reactiva uma categoria desactivada.',
  })
  @ValidateIf(wasSent)
  @IsBoolean()
  isActive?: boolean;
}
