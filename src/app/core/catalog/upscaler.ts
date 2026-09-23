/**
 * The hidden upscaler model behind the Upscale action (fal clarity-upscaler,
 * family id `upscaler`) and its margin-priced credit cost.
 * Entry points: UPSCALER, upscaleCreditCost.
 */
import { STUDIO_MARGIN } from './credit-cost';

/** Hidden utility model powering the Upscale action (fal clarity-upscaler). */
export const UPSCALER = {
  id: 'upscaler',
  name: 'Precision Upscale',
  providerCost: 0.04,
} as const;

export function upscaleCreditCost(): number {
  return Math.ceil((UPSCALER.providerCost / (1 - STUDIO_MARGIN)) * 100);
}
