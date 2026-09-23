/**
 * Catalog version. Bump on ANY change to a family's id, options, prices or
 * provider mapping. GET /catalog serves it, clients send it back with a
 * request, and the gateway answers an invalid request from an older version
 * with 409 catalog_stale. `catalog-version.spec.ts` fails if the catalog
 * content hash changes without a bump.
 */
export const CATALOG_VERSION = '2026-09-23.2';

export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio';
export type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit';
export type AudioMode = 'off' | 'on' | 'voice';
export type AudioCapability = 'included' | 'none' | 'selectable';

export interface FamilyOption {
  value: string;
  label: string;
  tooltip: string;
  /** Small highlight tag rendered on the chip, e.g. "Latest". Display only. */
  tag?: string;
  /**
   * The option `defaultSettings` picks. Separate from `tag` on purpose: until
   * 2026-09-22 the badge WAS the default marker, so adding a newer model moved
   * every new generation onto it as a side effect of labelling it. The newest
   * model and the one we are willing to put in front of someone by default are
   * different questions — a model with no smoke behind it can be offered
   * without being the thing everyone gets.
   */
  isDefault?: boolean;
}

export interface GenerationSettings {
  version?: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  durationS?: number;
  /** Outputs per run (1–4). Price multiplies per output. */
  batch?: number;
  /** Style preset id (style-presets.ts). Set server-side; free — no price impact. */
  style?: string;
  /** Persona id used for this generation. Set server-side; likeness pipeline. */
  persona?: string;
  /** Trend preset id — stamped when the prompt came from a trend prefill. */
  trend?: string;
  /** Video audio selection, only meaningful when capabilities.audio === 'selectable'. */
  audio?: AudioMode;
  /** Video generation mode — text-to-video, image-to-video, extend, etc. */
  mode?: VideoMode;
  /** Conversational continuation id, for models that support edit/extend by reference. */
  interactionId?: string;
}

export interface ModelFamily {
  id: string;
  name: string;
  provider: string;
  logo: string;
  kind: ModelKind;
  blurb: string;
  capabilities: {
    versions?: FamilyOption[];
    aspectRatios: string[];
    resolutions?: FamilyOption[];
    /**
     * Resolution tiers this family cannot actually deliver at a given aspect
     * ratio, keyed by ratio. A tier the provider will clamp must not be
     * offered at a price that describes the unclamped size.
     */
    resolutionExclusions?: Record<string, string[]>;
    /**
     * Resolution tiers each version can actually produce, keyed by version.
     * A version absent from this map is unrestricted.
     *
     * This lives here as data because it used to live in the left panel as a
     * hardcoded GPT version check: adding GPT Image 2.5 on 2026-09-22 silently
     * withheld 2K and 4K from the two new models, which both support them.
     * Encoding the limit next to the versions it describes means adding a
     * version cannot quietly narrow the offer again. Seedream uses it for the
     * pixel window of each endpoint.
     */
    versionResolutions?: Record<string, string[]>;
    /**
     * Quality settings each version accepts, keyed by version. A version absent
     * from this map is unrestricted. Same contract as `versionResolutions`.
     */
    versionQualities?: Record<string, string[]>;
    qualities?: FamilyOption[];
    durations?: number[];
    audio?: AudioCapability;
    modes?: VideoMode[];
    /** Expected provider render seconds per output second, for wait-time estimates. */
    expectedSPerS?: number;
    imageInput: boolean;
    maskInput: boolean;
  };
  /** Provider cost of the OUTPUT alone, for these settings. */
  providerCost(settings: GenerationSettings): number;
  /**
   * Provider cost of the INPUT side: the prompt tokens and, when a reference
   * image rides along, the image input tokens. Absent means the provider bills
   * a flat price per output and inputs are free (fal's image endpoints).
   */
  inputCost?(input: GenerationInput, settings: GenerationSettings): number;
}

/** What the customer attached, as far as price is concerned. */
export interface GenerationInput {
  hasReference: boolean;
  /** How many reference images ride along. Absent means one when hasReference. */
  referenceCount?: number;
}

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

const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];

/**
 * FLUX.2 takes `image_size` as `{width, height}`. [pro], [flex] and [max]
 * take 256–2560 per edge with a 4,194,304 px area cap and want both edges
 * divisible by 16. Every size below satisfies all three endpoints, and every tier's pixel count is at or under its megapixel label
 * in fal's units (1 MP = 1,048,576 px, which is how fal's own 1024×1024
 * example prices as one megapixel), so "rounded up to the nearest megapixel"
 * bills exactly the tier. Only 1:1 reaches 4MP inside the edge limits, which
 * is why the 4MP tier is withheld from every other ratio. Keyed
 * `aspectRatio:resolution`; this table drives the provider request in
 * `_shared/generation-request.ts`, so a tier we sell is always a size we send.
 */
export const FLUX_DIMS: Record<string, { width: number; height: number }> = {
  '1:1:1MP': { width: 1024, height: 1024 },
  '4:3:1MP': { width: 1152, height: 864 },
  '3:4:1MP': { width: 864, height: 1152 },
  '16:9:1MP': { width: 1344, height: 752 },
  '9:16:1MP': { width: 752, height: 1344 },
  '1:1:2MP': { width: 1440, height: 1440 },
  '4:3:2MP': { width: 1632, height: 1216 },
  '3:4:2MP': { width: 1216, height: 1632 },
  '16:9:2MP': { width: 1888, height: 1056 },
  '9:16:2MP': { width: 1056, height: 1888 },
  '1:1:4MP': { width: 2048, height: 2048 },
  '4:3:4MP': { width: 2048, height: 1536 },
  '3:4:4MP': { width: 1536, height: 2048 },
  '16:9:4MP': { width: 2048, height: 1152 },
  '9:16:4MP': { width: 1152, height: 2048 },
};

const FLUX_MP: Record<string, number> = { '1MP': 1, '2MP': 2, '4MP': 4 };

/**
 * FLUX.2 is priced at fal's published rate, read off each model page on
 * 2026-09-22, and carried through the margin formula like every other family:
 *   pro   $0.03 for the first megapixel, $0.015 per extra
 *   flex  $0.05 per megapixel
 *   max   $0.07 for the first megapixel, $0.03 per extra
 * Text-to-image only, so the "input side" fal mentions is zero for us.
 * [dev] was withdrawn 2026-09-23: it cost more than [pro] under its flat
 * retail tiers, and its open weights carry a non-commercial licence.
 */
function fluxProviderCost(s: GenerationSettings): number {
  const mp = FLUX_MP[s.resolution ?? '1MP'] ?? 1;
  const version = s.version ?? 'pro';
  if (version === 'flex') return 0.05 * mp;
  if (version === 'max') return 0.07 + 0.03 * (mp - 1);
  return 0.03 + 0.015 * (mp - 1);
}

export function fluxDims(s: GenerationSettings): { width: number; height: number } {
  return FLUX_DIMS[`${s.aspectRatio ?? '1:1'}:${s.resolution ?? '1MP'}`] ?? FLUX_DIMS['1:1:1MP'];
}

/**
 * Seedream takes `image_size` as `{width, height}` and no aspect ratio, so the
 * ratio rides in the dimensions. Keyed `aspectRatio:resolution`. Each version
 * has its own pixel window (fal OpenAPI schemas, 2026-09-22):
 *   4.0     960² – 4096² total
 *   4.5     3,686,400 (2560×1440) – 16,777,216 total  → 2K and 4K only
 *   5 Lite  3,686,400 – 9,437,184 (3072²) total        → 2K only
 *   5 Pro   1,048,576 – 4,194,304 total                → 1K and 2K only
 * The tiers each version cannot fill are withheld via `versionResolutions`.
 */
export const SEEDREAM_DIMS: Record<string, { width: number; height: number }> = {
  '1:1:1K': { width: 1024, height: 1024 },
  '4:3:1K': { width: 1152, height: 864 },
  '3:4:1K': { width: 864, height: 1152 },
  '16:9:1K': { width: 1344, height: 756 },
  '9:16:1K': { width: 756, height: 1344 },
  '1:1:2K': { width: 2048, height: 2048 },
  '4:3:2K': { width: 2304, height: 1728 },
  '3:4:2K': { width: 1728, height: 2304 },
  '16:9:2K': { width: 2688, height: 1512 },
  '9:16:2K': { width: 1512, height: 2688 },
  '1:1:4K': { width: 4096, height: 4096 },
  '4:3:4K': { width: 4096, height: 3072 },
  '3:4:4K': { width: 3072, height: 4096 },
  '16:9:4K': { width: 4096, height: 2304 },
  '9:16:4K': { width: 2304, height: 4096 },
};

/**
 * Seedream 5 Pro refuses anything under 1,048,576 px. The shared 1K table's
 * non-square sizes are 995,328 and 1,016,064 px, so Pro gets 1K sizes that
 * clear the floor while staying under its $0.0675 tier (≤ 1536² px).
 */
const SEEDREAM_PRO_1K_DIMS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1216, height: 912 },
  '3:4': { width: 912, height: 1216 },
  '16:9': { width: 1408, height: 800 },
  '9:16': { width: 800, height: 1408 },
};

export function seedreamDims(s: GenerationSettings): { width: number; height: number } {
  const aspectRatio = s.aspectRatio ?? '1:1';
  const resolution = s.resolution ?? '1K';
  if (s.version === '5-pro' && resolution === '1K') {
    return SEEDREAM_PRO_1K_DIMS[aspectRatio] ?? SEEDREAM_PRO_1K_DIMS['1:1'];
  }
  return SEEDREAM_DIMS[`${aspectRatio}:${resolution}`] ?? SEEDREAM_DIMS['1:1:1K'];
}

/** Seedream 5 Pro's two price tiers split at 1536² px; every 2K size is above it. */
const SEEDREAM_PRO_TIER_PX = 1536 * 1536;

/**
 * Flat per-image prices from each fal model page, 2026-09-22. Every Seedream
 * endpoint bills per output image regardless of prompt or reference (5 Pro's
 * edit endpoint charges only from the SECOND input image, and we send one).
 */
function seedreamProviderCost(s: GenerationSettings): number {
  const version = s.version ?? '4';
  if (version === '4.5') return 0.04;
  if (version === '5-lite') return 0.035;
  if (version !== '5-pro') return 0.03;
  const { width, height } = seedreamDims(s);
  return width * height <= SEEDREAM_PRO_TIER_PX ? 0.0675 : 0.135;
}
const AR_VIDEO = ['16:9', '9:16', '1:1'];

/** Hard ceiling on provider spend for video per user per rolling 24 h. */
export const VIDEO_DAILY_CAP_USD = 40;

const RES_TOOLTIPS: Record<string, string> = {
  '1K': 'Output size ~1024px. Resolution is pixel count — not detail effort.',
  '2K': 'Output size ~2048px. Sharper for print and zooming; same content quality.',
  '4K': 'Output size ~3840px. Largest files, highest cost.',
};

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

/** Margin baked into the credit charge table. 1 credit = $0.01 of Studio retail. */
export const STUDIO_MARGIN = 0.4;

/** Monthly credit grant per subscription plan (owner is unlimited, never granted). */
export const PLAN_CREDITS = { studio: 1500, pro: 3750 } as const;

/** Monthly list price per plan, and the launch price for a first-time customer's
 * first 60 days (Stripe applies it as a $5/mo coupon — see STRIPE_LAUNCH_COUPON_ID). */
export const PLAN_PRICE_USD = { studio: 15, pro: 30 } as const;
export const PLAN_PROMO_USD = { studio: 10, pro: 25 } as const;

/** Add-on packs bought on Pro carry this multiplier. */
export const PRO_PURCHASE_RATE = 1.25;

/**
 * Two true numbers about the same fact, which read as a contradiction when a
 * page picks one and another page picks the other.
 *
 * A job costs the same number of credits on either plan. What changes is what
 * a credit costs: 1c on Studio, 0.8c on Pro. That is 25% more credits per
 * dollar and 20% off the same job — the same 4:5 ratio, counted from opposite
 * ends. Both are derived here so no page can invent a third figure.
 */
const STUDIO_USD_PER_CREDIT = PLAN_PRICE_USD.studio / PLAN_CREDITS.studio;
const PRO_USD_PER_CREDIT = PLAN_PRICE_USD.pro / PLAN_CREDITS.pro;

/** How much less the same job costs on Pro. */
export const PRO_SAVING_PERCENT = Math.round(
  (1 - PRO_USD_PER_CREDIT / STUDIO_USD_PER_CREDIT) * 100,
);

/** How many more credits a dollar buys on Pro. */
export const PRO_EXTRA_CREDIT_PERCENT = Math.round(
  (STUDIO_USD_PER_CREDIT / PRO_USD_PER_CREDIT - 1) * 100,
);

/** The same bonus, applied to one-time add-on packs (PRO_PURCHASE_RATE). */
export const PRO_PACK_BONUS_PERCENT = Math.round((PRO_PURCHASE_RATE - 1) * 100);

/** Add-on packs: one-time purchases, tier rate × size bonus. Subscriber-only. */
export const CREDIT_PACKS: { usd: number; bonusPct: number }[] = [
  { usd: 10, bonusPct: 0 },
  { usd: 25, bonusPct: 5 },
  { usd: 50, bonusPct: 8 },
  { usd: 100, bonusPct: 10 },
];

export function packCredits(usd: number, plan: 'studio' | 'pro'): number {
  const pack = CREDIT_PACKS.find((p) => p.usd === usd);
  if (!pack) return 0;
  const rate = plan === 'pro' ? PRO_PURCHASE_RATE : 1;
  return Math.floor(usd * 100 * rate * (1 + pack.bonusPct / 100));
}

function veoRate(version: string | undefined, resolution: string | undefined): number {
  if (version === 'lite' && resolution === '1080p') return 0.08;
  if (version === 'lite') return 0.05;
  if (version === 'fast' && resolution === '4K') return 0.3;
  if (version === 'fast' && resolution === '1080p') return 0.12;
  if (version === 'fast') return 0.1;
  if (resolution === '4K') return 0.6;
  return 0.4;
}

function omniRate(resolution: string | undefined): number {
  if (resolution === '360p') return 0.03;
  if (resolution === '1080p') return 0.15;
  if (resolution === '4K') return 0.3;
  return 0.1;
}

function klingRate(audio: AudioMode | undefined): number {
  if (audio === 'voice') return 0.196;
  if (audio === 'on') return 0.168;
  return 0.112;
}

export const MODEL_FAMILIES: ModelFamily[] = [
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'image',
    blurb: 'Google’s all-rounder — Fast, Latest, and Pro tiers.',
    capabilities: {
      versions: [
        {
          value: 'fast',
          label: 'Fast',
          tooltip: 'Gemini 3.1 Flash Lite Image — quickest and cheapest, ~1K output only.',
        },
        {
          value: 'standard',
          label: 'Latest',
          tag: 'Latest',
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
  },
  {
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
  },
  {
    id: 'flux',
    name: 'FLUX',
    provider: 'Black Forest Labs',
    logo: '/logos/bfl.svg',
    kind: 'image',
    blurb: 'FLUX.2 — photoreal detail; Pro, Flex and Max tiers.',
    capabilities: {
      versions: [
        {
          value: 'pro',
          label: 'Pro',
          isDefault: true,
          tooltip: 'FLUX.2 [pro] — production quality, fast. Cheapest FLUX.',
        },
        {
          value: 'flex',
          label: 'Flex',
          tooltip: 'FLUX.2 [flex] — strongest prompt adherence and text rendering.',
        },
        { value: 'max', label: 'Max', tag: 'Latest', tooltip: 'FLUX.2 [max] — highest fidelity FLUX.' },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1MP', label: '1MP', tooltip: '~1 megapixel, e.g. 1024×1024.' },
        { value: '2MP', label: '2MP', tooltip: '~2 megapixels, e.g. 1440×1440.' },
        {
          value: '4MP',
          label: '4MP',
          tooltip: 'Square only: 2048×2048. FLUX.2 caps every edge at 2048px, so a wide or tall crop cannot reach 4 megapixels and is not offered this tier.',
        },
      ],
      // FLUX.2 clamps BOTH edges to 2048. Only 1:1 reaches 4MP — 16:9 tops out
      // at 2.36MP. Selling a "4MP" tier at those ratios would charge the 4MP
      // price for an image the endpoint cannot produce.
      resolutionExclusions: {
        '4:3': ['4MP'],
        '3:4': ['4MP'],
        '16:9': ['4MP'],
        '9:16': ['4MP'],
      },
      // No FLUX.2 text-to-image endpoint documents a reference-image input
      // (capability record, 2026-09-21; pro/flex/max schemas 2026-09-22).
      imageInput: false,
      maskInput: false,
    },
    providerCost: fluxProviderCost,
  },
  {
    id: 'seedream',
    name: 'Seedream',
    provider: 'ByteDance',
    logo: '/logos/bytedance.svg',
    kind: 'image',
    blurb: 'Seedream — strong aesthetics at a flat price per image, 4.0 to 5.0 Pro.',
    capabilities: {
      versions: [
        { value: '4', label: '4.0', isDefault: true, tooltip: 'Seedream 4.0 — 1K to 4K, cheapest tier.' },
        { value: '4.5', label: '4.5', tooltip: 'Seedream 4.5 — sharper detail. 2K and 4K only.' },
        { value: '5-lite', label: '5.0 Lite', tooltip: 'Seedream 5.0 Lite — newest generation, 2K only.' },
        {
          value: '5-pro',
          label: '5.0 Pro',
          tag: 'Latest',
          tooltip: 'Seedream 5.0 Pro — photographic realism. 1K and 2K; 2K is the dearer tier.',
        },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
      ],
      // Each endpoint's pixel window, from its fal OpenAPI schema — see
      // SEEDREAM_DIMS. A tier outside the window is not offered, so it cannot
      // be charged for a request fal would refuse.
      versionResolutions: {
        '4.5': ['2K', '4K'],
        '5-lite': ['2K'],
        '5-pro': ['1K', '2K'],
      },
      imageInput: true,
      maskInput: false,
    },
    providerCost: seedreamProviderCost,
  },
  // ── Video ───────────────────────────────────────────────────────────
  {
    id: 'veo',
    name: 'Veo 3.1',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'video',
    blurb: 'Veo 3.1 — cinematic clips with native audio, up to 4K.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: 'Best quality. $0.40/s, 4K $0.60/s.', tag: 'Latest' },
        { value: 'fast', label: 'Fast', tooltip: 'Quicker renders. $0.10/s (1080p $0.12, 4K $0.30).' },
        { value: 'lite', label: 'Lite', tooltip: 'Cheapest Veo. 720p/1080p only. $0.05/$0.08 per second.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD. Fastest and cheapest.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD. Standard $0.40/s, Fast $0.12/s.' },
        { value: '4K', label: '4K', tooltip: 'Ultra HD. Standard and Fast only.' },
      ],
      // Veo Lite tops out at 1080p; Fast is sold without a 4K tier.
      versionResolutions: {
        fast: ['720p', '1080p'],
        lite: ['720p', '1080p'],
      },
      durations: [4, 6, 8],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend'],
      expectedSPerS: 12,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => veoRate(s.version, s.resolution) * (s.durationS ?? 8),
  },
  {
    id: 'omni',
    name: 'Gemini Omni Flash 1.1',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'video',
    blurb: 'Omni Flash — conversational video: generate, then edit or extend by talking to it.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '360p', label: '360p', tooltip: 'Preview quality. $0.03/s.' },
        { value: '720p', label: '720p', tooltip: 'HD. $0.10/s.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD. $0.15/s.' },
        { value: '4K', label: '4K', tooltip: 'Ultra HD. $0.30/s.' },
      ],
      durations: [4, 6, 8, 10],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit'],
      expectedSPerS: 6,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => omniRate(s.resolution) * (s.durationS ?? 8),
  },
  {
    id: 'kling',
    name: 'Kling 3.0 Pro',
    provider: 'Kuaishou',
    logo: '/logos/kuaishou.svg',
    kind: 'video',
    blurb: 'Kling 3.0 Pro — smooth motion, optional soundtrack or voice.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      durations: [5, 10, 15],
      audio: 'selectable',
      modes: ['t2v', 'i2v', 'keyframes'],
      expectedSPerS: 20,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => klingRate(s.audio) * (s.durationS ?? 5),
  },
  {
    id: 'runway',
    name: 'Runway Gen-4.5',
    provider: 'Runway',
    logo: '/logos/runway.svg',
    kind: 'video',
    blurb: 'Gen-4.5 — director-grade control and consistency. Silent.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD. Same price as 1080p — smaller files.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD. Same price as 720p — sharper detail.' },
      ],
      durations: [5, 10],
      audio: 'none',
      modes: ['t2v', 'i2v'],
      expectedSPerS: 8,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => 0.12 * (s.durationS ?? 5),
  },
  {
    id: 'seedance',
    name: 'Seedance 2.5',
    provider: 'ByteDance',
    logo: '/logos/bytedance.svg',
    kind: 'video',
    blurb: 'Seedance 2.5 — crisp clips with audio at fal prices.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '480p', label: '480p', tooltip: 'Draft quality. $0.22/s.' },
        { value: '720p', label: '720p', tooltip: 'HD. $0.47/s.' },
      ],
      durations: [5, 10, 15],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v'],
      expectedSPerS: 20,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => (s.resolution === '480p' ? 0.2205 : 0.473) * (s.durationS ?? 5),
  },
];

/** Hidden utility model powering the Upscale action (fal clarity-upscaler). */
export const UPSCALER = {
  id: 'upscaler',
  name: 'Precision Upscale',
  providerCost: 0.04,
} as const;

/**
 * Hidden persona family — Google Nano Banana Pro at its highest settings,
 * with the persona's five photos as references. Not in the picker; selected
 * implicitly when a persona is active. One entry, so the persona model can be
 * swapped without touching Nano Banana's own prices or kill switch.
 */
export const PERSONA_GEN = {
  id: 'persona',
  name: 'Persona',
  providerModel: 'gemini-3-pro-image',
  resolution: '4K',
  photoCount: 5,
  /** Multiplier on the margin price. Raised only if the likeness test earns it. */
  premium: 1.0,
} as const;

/** The five guided capture angles, in the order they are sent to the model. */
export const PERSONA_SLOT_ORDER = [
  'front',
  'left_three_quarter',
  'right_three_quarter',
  'left_profile',
  'right_profile',
] as const;
export type PersonaSlot = (typeof PERSONA_SLOT_ORDER)[number];

/** Concurrent persona slots per plan. */
export const PERSONA_SLOTS: Record<'studio' | 'pro' | 'owner', number> = {
  studio: 2,
  pro: 5,
  owner: 5,
};

/** What each capture slot is called on screen, in every client. */
export const PERSONA_SLOT_LABELS: Record<PersonaSlot, string> = {
  front: 'Front',
  left_three_quarter: 'Left ¾',
  right_three_quarter: 'Right ¾',
  left_profile: 'Left profile',
  right_profile: 'Right profile',
};

/** Minimum short edge of a persona photo, in pixels. Clients check it first; the gateway re-checks. */
export const PERSONA_MIN_EDGE = 1024;

/** Largest persona photo the gateway accepts, in bytes (2.5 MB). */
export const PERSONA_MAX_BYTES = 2.5 * 1024 * 1024;

/** Longest persona name the gateway accepts, after trimming. */
export const PERSONA_NAME_MAX = 40;

/** The fixed settings a persona image is rendered and priced at. */
export function personaSettings(aspectRatio: string): GenerationSettings {
  return { version: 'pro', resolution: PERSONA_GEN.resolution, aspectRatio };
}

function nanoFamily(): ModelFamily {
  const family = familyById('nano-banana');
  if (!family) throw new Error('nano-banana family missing from the catalog');
  return family;
}

/** Our provider cost for one persona image: output, thinking, five photos, prompt. */
export function personaProviderCost(): number {
  const input: GenerationInput = { hasReference: true, referenceCount: PERSONA_GEN.photoCount };
  return providerCostWithInput(nanoFamily(), personaSettings('1:1'), input);
}

export function personaGenCreditCost(): number {
  return Math.ceil(
    (personaProviderCost() / (1 - STUDIO_MARGIN)) * 100 * PERSONA_GEN.premium,
  );
}

/**
 * The ratios a persona request passes the gateway's check with: Nano Banana's
 * ratios where its Pro version renders at the persona resolution.
 */
export function personaAspectRatios(): string[] {
  const nano = nanoFamily();
  return nano.capabilities.aspectRatios.filter((ratio) =>
    resolutionsFor(nano, ratio, 'pro').some((option) => option.value === PERSONA_GEN.resolution)
  );
}

/**
 * Studio panel AI edit tools — fixed-function (one curated backend model each,
 * user never picks) with fixed retail prices (NOT the PAYG margin formula).
 */
export interface EditTool {
  id: string;
  name: string;
  /** Fixed credit price per use — NOT the margin formula. */
  creditCost: number;
  /** Our provider cost, for margin bookkeeping only. */
  providerCost: number;
  /** Tool needs a painted mask before it can run. */
  needsMask: boolean;
  /** Tool needs a user prompt (generative fill). */
  needsPrompt: boolean;
  blurb: string;
}

export const EDIT_TOOLS: EditTool[] = [
  {
    id: 'edit-remove',
    name: 'Remove Object',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: false,
    blurb: 'Mask anything and AI repaints the scene behind it.',
  },
  {
    id: 'edit-fill',
    name: 'Generative Fill',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: true,
    blurb: 'Mask an area and describe what should appear there.',
  },
  {
    id: 'edit-expand',
    name: 'Expand',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Grow the canvas — AI paints beyond the original edges.',
  },
  {
    id: 'edit-bg',
    name: 'Remove Background',
    creditCost: 5,
    providerCost: 0.002,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Cut the subject out onto a transparent background.',
  },
];

export function editToolById(id: string): EditTool | undefined {
  return EDIT_TOOLS.find((t) => t.id === id);
}

export function familyById(id: string): ModelFamily | undefined {
  return MODEL_FAMILIES.find((f) => f.id === id);
}

/**
 * The resolution tiers a family really offers at one aspect ratio.
 *
 * The composer and the server both ask this, so a stale client cannot buy a
 * tier the provider would clamp: the chip is absent in the UI and the request
 * is refused before charge.
 */
export function resolutionsFor(
  family: ModelFamily,
  aspectRatio: string,
  version?: string,
): FamilyOption[] {
  const all = family.capabilities.resolutions ?? [];
  const excluded = family.capabilities.resolutionExclusions?.[aspectRatio];
  const byRatio = excluded ? all.filter((o) => !excluded.includes(o.value)) : all;
  const allowed = version ? family.capabilities.versionResolutions?.[version] : undefined;
  if (!allowed) return byRatio;
  return byRatio.filter((o) => allowed.includes(o.value));
}

/**
 * The quality settings one version of a family really accepts.
 *
 * Same reason as `resolutionsFor`: a quality one version accepts and another
 * rejects must not be offered or priced where the provider would refuse it.
 */
export function qualitiesFor(family: ModelFamily, version?: string): FamilyOption[] {
  const all = family.capabilities.qualities ?? [];
  const allowed = version ? family.capabilities.versionQualities?.[version] : undefined;
  if (!allowed) return all;
  return all.filter((o) => allowed.includes(o.value));
}

export function defaultSettings(family: ModelFamily): GenerationSettings {
  const c = family.capabilities;
  const defaultVersion = c.versions?.find((v) => v.isDefault)
    ?? c.versions?.find((v) => v.tag === 'Latest')
    ?? c.versions?.[0];
  const base: GenerationSettings = {
    version: defaultVersion?.value,
    aspectRatio: c.aspectRatios[0],
    resolution: c.resolutions?.[0]?.value,
    quality: c.qualities ? 'medium' : undefined,
    durationS: c.durations?.[0],
    batch: 1,
  };
  if (family.kind !== 'video') return base;
  base.mode = 't2v';
  if (c.audio === 'selectable') base.audio = 'off';
  return base;
}

export function videoFamilySupports(family: ModelFamily, mode: VideoMode): boolean {
  return family.capabilities.modes?.includes(mode) ?? false;
}

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

export function upscaleCreditCost(): number {
  return Math.ceil((UPSCALER.providerCost / (1 - STUDIO_MARGIN)) * 100);
}

/** How many reference images a video mode needs, and whether it needs a parent clip. */
export interface ReferenceRule {
  min: number;
  max: number;
  needsParent: boolean;
}

const REFERENCE_RULES: Record<VideoMode, ReferenceRule> = {
  t2v: { min: 0, max: 0, needsParent: false },
  i2v: { min: 1, max: 1, needsParent: false },
  ref2v: { min: 1, max: 3, needsParent: false },
  keyframes: { min: 2, max: 2, needsParent: false },
  extend: { min: 0, max: 0, needsParent: true },
  edit: { min: 0, max: 0, needsParent: true },
};

export function referenceRule(mode: VideoMode): ReferenceRule {
  return REFERENCE_RULES[mode];
}

/** The three audio settings a `selectable` video family offers, in chip order. */
export const AUDIO_OPTIONS: FamilyOption[] = [
  { value: 'off', label: 'Off', tooltip: 'Silent clip. Cheapest.' },
  { value: 'on', label: 'Sound', tooltip: 'Ambient sound and music.' },
  { value: 'voice', label: 'Voice', tooltip: 'Sound plus spoken dialogue.' },
];
