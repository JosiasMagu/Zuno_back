import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/**
 * Referência de uma transacção M-Pesa, como aparece no extracto e no SMS de
 * confirmação. Chega ao serviço sem espaços e em maiúsculas, para a mesma
 * transferência dar sempre a mesma referência.
 */
export function IsMpesaReference() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toUpperCase() : value,
    ),
    Matches(/^[A-Z0-9.-]{6,40}$/, {
      message:
        'A referência M-Pesa tem de ter entre 6 e 40 letras ou algarismos.',
    }),
  );
}
