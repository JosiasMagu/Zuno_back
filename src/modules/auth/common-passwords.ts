/**
 * Passwords que aparecem em todas as listas de fugas e que um atacante tenta
 * primeiro. Só entram as que cumprem o tamanho mínimo, porque as mais curtas
 * já são recusadas por isso. Comparam-se em minúsculas.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '11111111',
  '00000000',
  '12341234',
  '12345678a',
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwertyui',
  'qwertyuiop',
  'qwerty123',
  '1q2w3e4r',
  '1qaz2wsx',
  'abcd1234',
  'abc12345',
  'a1b2c3d4',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'superman',
  'trustno1',
  'senha123',
  'senha1234',
  'mocambique',
  'moçambique',
  'maputo123',
]);
