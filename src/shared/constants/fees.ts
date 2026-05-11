export const PLATFORM_FEE_PERCENT = 10;

export function calculatePlatformFee(amount: number): number {
  return Number((amount * (PLATFORM_FEE_PERCENT / 100)).toFixed(2));
}

export function calculateProviderPayout(
  amount: number,
  platformFee: number,
): number {
  return Number((amount - platformFee).toFixed(2));
}
