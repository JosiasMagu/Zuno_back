import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BookingStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindBookingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: BookingStatus,
    example: BookingStatus.PENDING,
    description: 'Filtrar reservas por status',
  })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}