/**
 * OpenAI GPT Image 2.5 (Flare, Sunburst): priced per output token from a
 * measured token table keyed by ratio, resolution and quality, plus prompt
 * and reference-image input tokens.
 * Entry points: GPT_IMAGE, GPT_DEFAULT_VERSION, GPT_REFERENCE_TOKENS.
 */
import type { GenerationInput, GenerationSettings, ModelFamily } from '../family-types';
import { PROMPT_TOKEN_ALLOWANCE, referenceCountOf } from '../generation-input';
import { AR_IMAGE, RES_TOOLTIPS } from './shared-options';

const GPT_QUALITY_TOOLTIPS: Record<string, string> = {
  low: 'Minimal compute — fast drafts and thumbnails. Same resolution, less detail.',
  medium: 'Balanced compute. Good default for final assets.',
  high: 'Strong detail and text rendering. Not a resolution setting.',
  xhigh: 'More compute than High, for fine texture and dense text.',
  max: 'Everything the model has. Slowest and dearest by a wide margin.',
};

/**
 * Image output tokens for the GPT Image 2.5 models, keyed
 * `aspectRatio:resolution`.
 *
 * OpenAI bills images per output token, and the token count tracks pixel area,
 * not our tier names. The previous shape — one flat price per quality, doubled
 * at 4K — could not express that, and it cost real money: every 1:1 2K image
 * was sold below cost, while 16:9 1K carried a 68% margin. See
 * docs/superpowers/specs/2026-09-22-catalog-refresh.md §11.
 *
 * Each row is the five quality steps OpenAI bills, in order:
 * [low, medium, high, xhigh, max]. Measured from the calculator in
 * developers.openai.com/api/docs/guides/image-generation on 2026-09-22 by
 * entering every size below, not interpolated; re-checked cell by cell in §13.
 *
 * GPT Image 1.5 and 2 were withdrawn from the offer on 2026-09-22 (§14):
 * version 2 sampled this same ladder at steps 0, 2 and 4, so it had no price
 * point 2.5 does not already sell on a newer model, and 1.5 was dearer per
 * token and 1K-only.
 */
const GPT_TOKENS: Record<string, readonly number[]> = {
  '1:1:1K': [196, 439, 1756, 3122, 7024],
  '4:3:1K': [134, 301, 1204, 2140, 4815],
  '3:4:1K': [134, 301, 1204, 2140, 4815],
  '16:9:1K': [106, 246, 947, 1683, 3787],
  '9:16:1K': [106, 246, 947, 1683, 3787],
  '1:1:2K': [397, 892, 3568, 6343, 14272],
  '4:3:2K': [247, 556, 2223, 3952, 8892],
  '3:4:2K': [247, 556, 2223, 3952, 8892],
  '16:9:2K': [157, 367, 1413, 2511, 5650],
  '9:16:2K': [157, 367, 1413, 2511, 5650],
  '1:1:4K': [427, 960, 3840, 6826, 15358],
  '4:3:4K': [395, 888, 3552, 6314, 14206],
  '3:4:4K': [395, 888, 3552, 6314, 14206],
  '16:9:4K': [371, 865, 3336, 5930, 13342],
  '9:16:4K': [371, 865, 3336, 5930, 13342],
};

/** Which step of GPT_TOKENS each quality label selects. Both 2.5 models share it. */
const GPT_QUALITY_STEP: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

export const GPT_DEFAULT_VERSION = '2.5-flare';

/** USD per token, from developers.openai.com/api/docs/pricing on 2026-09-22. */
const GPT_RATE = 30 / 1_000_000;
const GPT_TEXT_IN_RATE = 5 / 1_000_000;
const GPT_IMAGE_IN_RATE = 8 / 1_000_000;

/**
 * Image input tokens billed when a reference image is attached. OpenAI does
 * not publish the figure for the 2.5 models; it does for gpt-image-1 at high
 * input fidelity — which the guide says gpt-image-2 and later ALWAYS use — as
 * 65 + 129 per 512px tile + 6,240 for a non-square image, ≈ 7,079 tokens for
 * a 1024×1536 reference. That is the documented worst case and it is what we
 * price, because a reference on a low or medium generation is otherwise worth
 * more than the whole generation ($0.057 against $0.006–0.013). The openai
 * adapter logs `usage.input_tokens_details` on every call so this can be
 * replaced by a measured number after the first live reference generation.
 */
export const GPT_REFERENCE_TOKENS = 7_100;

function gptProviderCost(s: GenerationSettings): number {
  const aspectRatio = s.aspectRatio ?? '1:1';
  const quality = s.quality ?? 'medium';
  const row = GPT_TOKENS[`${aspectRatio}:${s.resolution ?? '1K'}`] ?? GPT_TOKENS['1:1:1K'];
  const step = GPT_QUALITY_STEP[quality];
  // An unknown quality is a bug upstream, not a discount: fall back to the
  // dearest step this row has rather than the cheapest.
  return row[step ?? row.length - 1] * GPT_RATE;
}

function gptInputCost(input: GenerationInput): number {
  const prompt = PROMPT_TOKEN_ALLOWANCE * GPT_TEXT_IN_RATE;
  return prompt + referenceCountOf(input) * GPT_REFERENCE_TOKENS * GPT_IMAGE_IN_RATE;
}

export const GPT_IMAGE: ModelFamily = {
  id: 'gpt-image',
  name: 'GPT Image',
  provider: 'OpenAI',
  logo: '/logos/openai.svg',
  kind: 'image',
  blurb: 'GPT Image 2.5 — five-step quality dial, true 4K, masked edits.',
  capabilities: {
    versions: [
      {
        value: '2.5-flare',
        label: 'Flare',
        tag: 'Latest',
        isDefault: true,
        tooltip: 'Fastest 2.5 model — everyday generation.',
      },
      {
        value: '2.5-sunburst',
        label: 'Sunburst',
        tooltip: 'Most capable 2.5 model — precision edits and dense text.',
      },
    ],
    aspectRatios: AR_IMAGE,
    resolutions: [
      { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
      { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
      { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
    ],
    qualities: [
      { value: 'low', label: 'Low', tooltip: GPT_QUALITY_TOOLTIPS['low'] },
      { value: 'medium', label: 'Medium', tooltip: GPT_QUALITY_TOOLTIPS['medium'] },
      { value: 'high', label: 'High', tooltip: GPT_QUALITY_TOOLTIPS['high'] },
      { value: 'xhigh', label: 'X-High', tooltip: GPT_QUALITY_TOOLTIPS['xhigh'] },
      { value: 'max', label: 'Max', tooltip: GPT_QUALITY_TOOLTIPS['max'] },
    ],
    imageInput: true,
    maskInput: true,
  },
  providerCost: gptProviderCost,
  inputCost: gptInputCost,
};
