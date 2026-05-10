import { ApiPropertyOptional } from '@nestjs/swagger';
import { ServiceBookingStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindServiceBookingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ServiceBookingStatus })
  @IsOptional()
  @IsEnum(ServiceBookingStatus)
  status?: ServiceBookingStatus;
}
