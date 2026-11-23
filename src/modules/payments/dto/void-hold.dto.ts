import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VoidHoldDto {
  @ApiProperty({
    description:
      'Porque é que a confirmação estava errada. Fica na auditoria e no ledger.',
    example:
      'A referência QGH7RT51XK era do pagamento da reserva seguinte na fila.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10, { message: 'Explica o motivo em pelo menos 10 caracteres.' })
  @MaxLength(500)
  reason!: string;
}
