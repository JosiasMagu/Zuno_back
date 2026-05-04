import { ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindDisputesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: DisputeStatus,
    example: DisputeStatus.AWAITING_OWNER,
    description: 'Filtrar disputas por status',
  })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}
