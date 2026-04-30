import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindPaymentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: PaymentStatus,
    example: PaymentStatus.PENDING,
    description: 'Filtrar pagamentos por status',
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;
}