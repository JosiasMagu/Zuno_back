import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindPayoutsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus, example: PayoutStatus.PENDING })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;
}
