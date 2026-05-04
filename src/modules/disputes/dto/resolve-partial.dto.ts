import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class ResolvePartialDto {
  @ApiProperty({
    example: 40,
    description: 'Percentual de reembolso parcial',
    minimum: 1,
    maximum: 99,
  })
  @IsInt()
  @Min(1)
  @Max(99)
  refundPercent: number;
}
