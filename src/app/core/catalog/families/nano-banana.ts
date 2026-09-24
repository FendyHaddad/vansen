/**
 * Google Nano Banana (Gemini image): Fast, Standard and Pro versions, priced per
 * output plus per-token input (prompt and reference images) and, on Pro, a
 * thinking-token allowance. Entry points: NANO_BANANA, NANO_PRO_THINKING_TOKENS.
 */
import type { GenerationInput, GenerationSettings, ModelFamily } from '../family-types';
import { PROMPT_TOKEN_ALLOWANCE, referenceCountOf } from '../generation-input';
import { AR_IMAGE, RES_TOOLTIPS } from './shared-options';

/**
 * Gemini bills each input image as 560 tokens at the model's text-input rate
 * ($0.25/1M Lite, $0.50/1M Flash, $2/1M Pro — ai.google.dev pricing,
 * checked 2026-09-23). Every image is billed, so the count matters.
 */
const NANO_REFERENCE_TOKENS = 560;
const NANO_TEXT_IN_RATE: Record<string, number> = {
  fast: 0.25 / 1_000_000,
  standard: 0.5 / 1_000_000,
  pro: 2 / 1_000_000,
};

/**
 * Nano Banana Pro always thinks before it draws, and Google bills the thought
 * tokens at $12/1M. The real count varies per request; 2,000 is a provisional
 * allowance until the `google_usage` log lines give a measured figure.
 */
export const NANO_PRO_THINKING_TOKENS = 2_000;
const NANO_THINKING_RATE = 12 / 1_000_000;

function nanoInputCost(input: GenerationInput, s: GenerationSettings): number {
  const rate = NANO_TEXT_IN_RATE[s.version ?? 'standard'] ?? NANO_TEXT_IN_RATE['standard'];
  const tokens = PROMPT_TOKEN_ALLOWANCE + referenceCountOf(input) * NANO_REFERENCE_TOKENS;
  return tokens * rate;
}

export const NANO_BANANA: ModelFamily = {
  id: 'nano-banana',
  name: 'Nano Banana',
  provider: 'Google',
  logo: '/logos/google.svg',
  kind: 'image',
  blurb: 'Google’s all-rounder — Fast, Standard, and Pro tiers.',
  capabilities: {
    versions: [
      {
        value: 'fast',
        label: 'Fast',
        tooltip: 'Gemini 3.1 Flash Lite Image — quickest and cheapest, ~1K output only.',
      },
      {
        value: 'standard',
        label: 'Standard',
        isDefault: true,
        tooltip: 'Gemini 3.1 Flash Image — current generation, up to 4K.',
      },
      {
        value: 'pro',
        label: 'Pro',
        tooltip: 'Gemini 3 Pro Image — top fidelity for complex scenes and text.',
      },
    ],
    aspectRatios: AR_IMAGE,
    resolutions: [
      { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
      { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
      { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
    ],
    // Gemini 3.1 Flash Lite Image outputs ~1K only.
    versionResolutions: {
      fast: ['1K'],
    },
    imageInput: true,
    maskInput: false,
  },
  providerCost: (s) => {
    // Nano Banana 2 Lite: 1120 tokens for a 1K image at $30/1M image output
    // tokens. Repointed here on 2026-09-22 — the previous model,
    // gemini-2.5-flash-image, is shut down by Google on 2026-10-02.
    if (s.version === 'fast') return 0.0336;
    if (s.version === 'pro') {
      const output = s.resolution === '4K' ? 0.24 : 0.134;
      return output + NANO_PRO_THINKING_TOKENS * NANO_THINKING_RATE;
    }
    return { '1K': 0.067, '2K': 0.101, '4K': 0.151 }[s.resolution ?? '1K'] ?? 0.067;
  },
  inputCost: nanoInputCost,
};
