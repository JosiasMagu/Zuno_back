import { percentOf, roundMoney } from './policy';

export const PLATFORM_FEE_PERCENT = 10;

export function calculatePlatformFee(amount: number): number {
  return percentOf(amount, PLATFORM_FEE_PERCENT);
}

export function calculateProviderPayout(
  amount: number,
  platformFee: number,
): number {
  return roundMoney(amount - platformFee);
}
