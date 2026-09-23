/**
 * What a generation's input side costs: reference-image counting and the
 * prompt length cap that bounds token-billed prompt spend.
 * Entry points: NO_INPUT, referenceCountOf, PROMPT_MAX_CHARS, PROMPT_TOKEN_ALLOWANCE.
 */
import type { GenerationInput } from './family-types.ts';

export const NO_INPUT: GenerationInput = { hasReference: false };

/** Every reference image is billed, so the price must know how many there are. */
export function referenceCountOf(input: GenerationInput): number {
  if (!input.hasReference) return 0;
  return input.referenceCount ?? 1;
}

/**
 * Prompt length cap, enforced by the composer (maxlength) and the gateway.
 * Token-billed providers charge for every prompt token, so an unbounded
 * prompt is an unbounded cost on a fixed credit price. The cap makes the
 * worst case a known number, and PROMPT_TOKEN_ALLOWANCE prices that worst
 * case into every token-billed generation instead of making the credit
 * price jitter as someone types.
 */
export const PROMPT_MAX_CHARS = 2000;

/**
 * Tokens billed for the prompt, assumed on every token-billed generation.
 * 2000 characters of English is ~500 tokens; the style modifier and a persona
 * trigger word add under 30 more. 800 covers that with room for dense text.
 */
export const PROMPT_TOKEN_ALLOWANCE = 800;
