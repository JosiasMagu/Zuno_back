import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsString,
  Matches,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import {
  E164_MZ_MOBILE,
  normalizeMzPhone,
} from '../../../shared/phone/mz-phone';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '../auth.policy';
import { COMMON_PASSWORDS } from '../common-passwords';

/**
 * Passa um telemóvel moçambicano para E.164. O que não for um telemóvel
 * moçambicano segue como veio, só sem espaços nas pontas.
 */
export function toE164WhenPossible(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return normalizeMzPhone(value) ?? value.trim();
}

/**
 * Telefone de uma conta. Aceita os formatos habituais de um telemóvel
 * moçambicano e entrega ao serviço sempre o mesmo, `+258841234567`, para
 * que cada número corresponda a uma só conta.
 */
export function IsMzPhone() {
  return applyDecorators(
    Transform(({ value }) => toE164WhenPossible(value)),
    Matches(E164_MZ_MOBILE, {
      message:
        'Indica um número de telemóvel moçambicano válido, por exemplo 841234567.',
    }),
  );
}

@ValidatorConstraint({ name: 'fitsInBcrypt' })
class FitsInBcrypt implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES
    );
  }

  defaultMessage(): string {
    return 'A password é demasiado longa.';
  }
}

@ValidatorConstraint({ name: 'notCommonPassword' })
class NotCommonPassword implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' && !COMMON_PASSWORDS.has(value.toLowerCase())
    );
  }

  defaultMessage(): string {
    return 'Essa password é demasiado comum. Escolhe outra.';
  }
}

/**
 * Uma password a definir (registo, reset ou troca). Conta o tamanho, e não a
 * mistura de maiúsculas, dígitos e símbolos: recusa-se a que for curta, a
 * que o bcrypt cortaria e as mais usadas no mundo.
 */
export function IsNewPassword() {
  return applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH, {
      message: `A password tem de ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
    }),
    Validate(FitsInBcrypt),
    Validate(NotCommonPassword),
  );
}
