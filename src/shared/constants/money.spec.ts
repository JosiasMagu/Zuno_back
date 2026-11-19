import { calculatePlatformFee, calculateProviderPayout } from './fees';
import { percentOf, roundMoney } from './policy';

describe('roundMoney', () => {
  it.each([
    [1500, 1500],
    [100.456, 100.46],
    [100.454, 100.45],
    [0.1 + 0.2, 0.3],
    [1499.999, 1500],
  ])('rounds %s to %s', (value, expected) => {
    expect(roundMoney(value)).toBe(expected);
  });

  it('rounds half a cent up, where floating point would round it down', () => {
    // Em vírgula flutuante 1.005 é 1.00499999..., e toFixed(2) dava 1.00.
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
  });

  it('leaves a value that is not a number as it is, for the caller to refuse', () => {
    expect(roundMoney(Number.NaN)).toBeNaN();
  });
});

describe('percentOf', () => {
  it.each([
    [1500, 10, 150],
    [4500, 30, 1350],
    [5000, 30, 1500],
    [999.99, 10, 100],
    [1000, 33, 330],
    [0, 10, 0],
  ])('%s at %s%% is %s', (amount, percent, expected) => {
    expect(percentOf(amount, percent)).toBe(expected);
  });

  it('does the whole sum in decimal: 10% of 1.15 is 0.12', () => {
    // A mesma conta em vírgula flutuante dá 0.11499999999999999.
    expect(Number((1.15 * (10 / 100)).toFixed(2))).toBe(0.11);
    expect(percentOf(1.15, 10)).toBe(0.12);
  });

  it('rounds half a cent up', () => {
    expect(percentOf(10.05, 50)).toBe(5.03);
    expect(percentOf(0.25, 10)).toBe(0.03);
  });
});

describe('platform fee', () => {
  it('is 10% of the amount', () => {
    expect(calculatePlatformFee(4500)).toBe(450);
  });

  it('does not lose a cent on prices with cents', () => {
    expect(calculatePlatformFee(1.15)).toBe(0.12);
    expect(calculatePlatformFee(1234.55)).toBe(123.46);
  });

  it('leaves the provider the amount minus the fee, to the cent', () => {
    expect(calculateProviderPayout(4500, 450)).toBe(4050);
    expect(calculateProviderPayout(1234.55, 123.46)).toBe(1111.09);
  });
});
