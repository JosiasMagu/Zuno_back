import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Paginação dedicada ao endpoint `GET /equipment/me/listings`.
 *
 * Distinta da `PaginationQueryDto` global porque o default de `limit` aqui
 * é mais alto (50) para preservar a UX actual do frontend, que ainda lista
 * todos os itens do provider sem paginação. Quando o frontend passar a usar
 * pagina‹ção, basta enviar `page` e `limit` explicitamente.
 */
export class FindMyListingsQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Página atual',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    example: 50,
    description: 'Quantidade de itens por página (máx. 100)',
    default: 50,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}
