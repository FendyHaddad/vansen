/**
 * The margin formula that turns a provider cost into integer credits. The
 * composer and the gateway both price through here, so the number on the
 * button is the number on the ledger. Entry points: creditCost,
 * providerCostWithInput, STUDIO_MARGIN. Edit tools use fixed prices instead.
 */
import type { GenerationInput, GenerationSettings, ModelFamily } from './family-types.ts';
import { NO_INPUT } from './generation-input.ts';

/** Margin baked into the credit charge table. 1 credit = $0.01 of Studio retail. */
export const STUDIO_MARGIN = 0.4;

/** Provider cost of one output including its inputs, in USD. */
export function providerCostWithInput(
  family: ModelFamily,
  s: GenerationSettings,
  input: GenerationInput = NO_INPUT,
): number {
  return family.providerCost(s) + (family.inputCost?.(input, s) ?? 0);
}

/**
 * Integer credits for one output: ceil(cost / (1 − margin) × 100), where cost
 * covers the output AND the inputs the customer attached. The composer and the
 * gateway both pass what they know about the reference, so the number on the
 * button is the number on the ledger.
 */
export function creditCost(
  family: ModelFamily,
  s: GenerationSettings,
  input: GenerationInput = NO_INPUT,
): number {
  return Math.ceil((providerCostWithInput(family, s, input) / (1 - STUDIO_MARGIN)) * 100);
}
