const COUNTRY_CODE = '258';

// Telemóveis moçambicanos: nove dígitos a começar por 82 ou 83 (Tmcel),
// 84 ou 85 (Vodacom), 86 ou 87 (Movitel).
const NATIONAL_MOBILE = /^8[2-7]\d{7}$/;

/** Um telemóvel moçambicano já em E.164, como `+258841234567`. */
export const E164_MZ_MOBILE = /^\+2588[2-7]\d{7}$/;

/**
 * Converte um telemóvel moçambicano para E.164 (`+258841234567`).
 *
 * Aceita o número nacional (`841234567`), com indicativo (`258841234567`,
 * `+258841234567`, `00258841234567`) e com espaços, traços, pontos ou
 * parênteses a separar os dígitos. Devolve null se o texto não for um
 * telemóvel moçambicano.
 */
export function normalizeMzPhone(input: string): string | null {
  const compact = input.replace(/[\s\-.()]/g, '');
  const national = compact.replace(/^(\+|00)?258(?=\d{9}$)/, '');

  return NATIONAL_MOBILE.test(national) ? `+${COUNTRY_CODE}${national}` : null;
}
