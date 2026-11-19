import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Até que página se pode pedir. A paginação é por OFFSET: sem tecto, um
 * pedido a page=1000000 num endpoint público obriga a base a percorrer
 * milhões de linhas para as deitar fora.
 */
export const MAX_PAGE = 1000;

/** Tamanho máximo de um termo de pesquisa, que vai para um ILIKE. */
export const MAX_SEARCH_LENGTH = 100;

export class PaginationQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Página atual',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 10,
    description: 'Quantidade de itens por página',
    default: 10,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}
