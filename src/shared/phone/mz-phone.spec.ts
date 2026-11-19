import { E164_MZ_MOBILE, normalizeMzPhone } from './mz-phone';

describe('normalizeMzPhone()', () => {
  it.each([
    ['841234567', '+258841234567'],
    ['258841234567', '+258841234567'],
    ['+258841234567', '+258841234567'],
    ['00258841234567', '+258841234567'],
    ['84 123 4567', '+258841234567'],
    ['+258 84 123-4567', '+258841234567'],
    ['(84) 123.4567', '+258841234567'],
    ['  871234567  ', '+258871234567'],
  ])('converte %p em %p', (input, expected) => {
    expect(normalizeMzPhone(input)).toBe(expected);
  });

  it.each(['82', '83', '84', '85', '86', '87'])(
    'aceita o prefixo %s',
    (prefix) => {
      expect(normalizeMzPhone(`${prefix}1234567`)).toBe(`+258${prefix}1234567`);
    },
  );

  it.each([
    ['vazio', ''],
    ['texto', 'admin'],
    ['fixo de Maputo', '21123456'],
    ['prefixo que não é de telemóvel', '811234567'],
    ['dígitos a menos', '84123456'],
    ['dígitos a mais', '8412345678'],
    ['indicativo de outro país', '+27841234567'],
    ['indicativo repetido', '258258841234567'],
    ['letras no meio', '84123a567'],
  ])('devolve null para %s', (_case, input) => {
    expect(normalizeMzPhone(input)).toBeNull();
  });

  it('devolve sempre um número que passa na expressão E.164', () => {
    expect(normalizeMzPhone('84 123 4567')).toMatch(E164_MZ_MOBILE);
  });
});
