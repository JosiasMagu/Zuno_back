/**
 * Lê um booleano que pode chegar como texto, num formulário multipart ou
 * numa query string. `@Type(() => Boolean)` não serve para isto: converte a
 * string "false" em true. O que não for um booleano segue como veio, para a
 * validação o recusar.
 */
export function toOptionalBoolean(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}
