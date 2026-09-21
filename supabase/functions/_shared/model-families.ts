/**
 * Catalog version. Bump on ANY change to a family's id, options, prices or
 * provider mapping. Clients send it back with a request so the server can tell
 * a stale composer's quote from a current one, and the Dart fixture in the
 * mobile repo pins it. `catalog-version.spec.ts` fails if the catalog content
 * hash changes without a bump.
 */
export const CATALOG_VERSION = '2026-09-22.2';

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
     * hardcoded `version !== '2'`: adding GPT Image 2.5 on 2026-09-22 silently
     * withheld 2K and 4K from the two new models, which both support them.
     * Encoding the limit next to the versions it describes means adding a
     * version cannot quietly narrow the offer again.
     */
    versionResolutions?: Record<string, string[]>;
    qualities?: FamilyOption[];
    durations?: number[];
    audio?: AudioCapability;
    modes?: VideoMode[];
    /** Expected provider render seconds per output second, for wait-time estimates. */
    expectedSPerS?: number;
    imageInput: boolean;
    maskInput: boolean;
  };
  providerCost(settings: GenerationSettings): number;
}

const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];

/**
 * FLUX.2 (`fal-ai/flux-2`) takes `image_size` as `{width, height}` with BOTH
 * edges clamped to 512–2048. The clamp means only 1:1 actually reaches 4MP —
 * 16:9 tops out at 2.36MP — which is why the 4MP tier is withheld from every
 * other ratio. Keyed `aspectRatio:resolution`; this table drives the provider
 * request in `_shared/generation-request.ts`, so a tier we sell is always a
 * size we send.
 */
export const FLUX_DIMS: Record<string, { width: number; height: number }> = {
  '1:1:1MP': { width: 1024, height: 1024 },
  '4:3:1MP': { width: 1152, height: 864 },
  '3:4:1MP': { width: 864, height: 1152 },
  '16:9:1MP': { width: 1344, height: 756 },
  '9:16:1MP': { width: 756, height: 1344 },
  '1:1:2MP': { width: 1448, height: 1448 },
  '4:3:2MP': { width: 1632, height: 1224 },
  '3:4:2MP': { width: 1224, height: 1632 },
  '16:9:2MP': { width: 1888, height: 1062 },
  '9:16:2MP': { width: 1062, height: 1888 },
  '1:1:4MP': { width: 2048, height: 2048 },
  '4:3:4MP': { width: 2048, height: 1536 },
  '3:4:4MP': { width: 1536, height: 2048 },
  '16:9:4MP': { width: 2048, height: 1152 },
  '9:16:4MP': { width: 1152, height: 2048 },
};

/**
 * Flat price per tier. fal quotes FLUX.2 per megapixel, but a per-megapixel
 * charge makes the credit ladder non-monotonic once it is rounded to whole
 * credits — two adjacent sizes can cost the same, and a wide 4MP can cost less
 * than a square 2MP. These tiers are the deliberate retail shape; the 2048
 * clamp is handled by not offering a tier we cannot fill (see
 * `resolutionExclusions` on the family) rather than by discounting it.
 */
export const FLUX_TIER_USD: Record<string, number> = {
  '1MP': 0.03,
  '2MP': 0.06,
  '4MP': 0.12,
};

export function fluxDims(s: GenerationSettings): { width: number; height: number } {
  return FLUX_DIMS[`${s.aspectRatio ?? '1:1'}:${s.resolution ?? '1MP'}`] ?? FLUX_DIMS['1:1:1MP'];
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
  high: 'Maximum compute per image — best textures and text rendering. Not a resolution setting.',
};

/**
 * Provider cost per image (square, ~1K output) by version and quality.
 *
 * The 2.5 rows are measured, not estimated: OpenAI's own calculator reports
 * 196 / 439 / 1756 output tokens for low / medium / high at 1024x1024, billed
 * at $30 per 1M image output tokens (platform.openai.com/docs/guides/image-generation,
 * read 2026-09-22).
 *
 * The '2' and '1.5' rows are NOT verified. They are flat per-image figures,
 * but OpenAI bills images per token, so a flat table cannot be right in shape —
 * and '2' happens to equal 2.5's low/high/max rather than its low/medium/high,
 * which is either coincidence or a tier shift nobody has checked. Settling it
 * needs one real generation with `usage` read back from the response. Until
 * then these stay as they were rather than being replaced by a better guess.
 */
const GPT_COST: Record<string, Record<string, number>> = {
  '2.5-sunburst': { low: 0.00588, medium: 0.01317, high: 0.05268 },
  '2.5-flare': { low: 0.00588, medium: 0.01317, high: 0.05268 },
  '2': { low: 0.006, medium: 0.053, high: 0.211 },
  '1.5': { low: 0.009, medium: 0.034, high: 0.133 },
};

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
      if (s.version === 'pro') return s.resolution === '4K' ? 0.24 : 0.134;
      return { '1K': 0.067, '2K': 0.101, '4K': 0.151 }[s.resolution ?? '1K'] ?? 0.067;
    },
  },
  {
    id: 'gpt-image',
    name: 'GPT Image',
    provider: 'OpenAI',
    logo: '/logos/openai.svg',
    kind: 'image',
    blurb: 'Quality dial for compute effort; 2 and 2.5 add true 4K and masked edits.',
    capabilities: {
      versions: [
        { value: '1.5', label: '1.5', tooltip: 'Previous generation, ~1K output.' },
        {
          value: '2',
          label: '2',
          isDefault: true,
          tooltip: 'GPT Image 2. Any resolution up to 3840px, masked editing.',
        },
        {
          value: '2.5-flare',
          label: '2.5 Flare',
          tag: 'Latest',
          tooltip: 'Fastest 2.5 model — high-quality everyday generation.',
        },
        {
          value: '2.5-sunburst',
          label: '2.5 Sunburst',
          tooltip: 'Most capable 2.5 model — for edits where precision matters most.',
        },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] + ' (Not on version 1.5.)' },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] + ' (Not on version 1.5.)' },
      ],
      // gpt-image-1.5 accepts only the three standard sizes, so every request
      // collapses to ~1K. Versions 2 and both 2.5 models take arbitrary
      // dimensions up to 3840x2160 — see `_shared/provider-capabilities.json`.
      versionResolutions: {
        '1.5': ['1K'],
      },
      qualities: [
        { value: 'low', label: 'Low', tooltip: GPT_QUALITY_TOOLTIPS['low'] },
        { value: 'medium', label: 'Medium', tooltip: GPT_QUALITY_TOOLTIPS['medium'] },
        { value: 'high', label: 'High', tooltip: GPT_QUALITY_TOOLTIPS['high'] },
      ],
      imageInput: true,
      maskInput: true,
    },
    providerCost: (s) => {
      const version = s.version ?? '2';
      const base = GPT_COST[version]?.[s.quality ?? 'medium'] ?? 0.053;
      // OpenAI bills image output tokens, and tokens track pixel area, so a 4K
      // render costs materially more than the 1024x1024 the GPT_COST rows are
      // quoted at. 2.05x is the ratio measured for version 2. It is applied to
      // the 2.5 models on the assumption that they bill the same way; that is
      // NOT verified — see docs/superpowers/specs/2026-09-22-catalog-refresh.md.
      // Version 1.5 cannot produce 4K at all, so it never multiplies.
      if (version === '1.5' || s.resolution !== '4K') return base;
      return base * 2.05;
    },
  },
  {
    id: 'flux',
    name: 'FLUX',
    provider: 'Black Forest Labs',
    logo: '/logos/bfl.svg',
    kind: 'image',
    blurb: 'FLUX.2 — photoreal detail at a flat price per size.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1MP', label: '1MP', tooltip: '~1 megapixel, e.g. 1024×1024.' },
        { value: '2MP', label: '2MP', tooltip: '~2 megapixels, e.g. 1448×1448.' },
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
      // fal-ai/flux-2 documents no reference-image input (capability record,
      // 2026-09-21), so the family no longer offers one.
      imageInput: false,
      maskInput: false,
    },
    providerCost: (s) => FLUX_TIER_USD[s.resolution ?? '1MP'] ?? FLUX_TIER_USD['1MP'],
  },
  {
    id: 'seedream',
    name: 'Seedream',
    provider: 'ByteDance',
    logo: '/logos/bytedance.svg',
    kind: 'image',
    blurb: 'Seedream 4.0 — strong aesthetics at a low flat price.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
      ],
      imageInput: true,
      maskInput: false,
    },
    // fal: $0.03 per image at any resolution (verified 2026-07-05)
    providerCost: () => 0.03,
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

/** Hidden persona pipeline — fal flux-lora with the user's trained LoRA weights.
 * Not in the picker; selected implicitly when a persona is active. */
export const PERSONA_GEN = {
  id: 'persona',
  name: 'Persona',
  // fal-ai/flux-lora ≈ $0.035 per ~1MP image (verify on first live bill).
  providerCost: 0.035,
} as const;

/** Persona LoRA training — fixed retail like EDIT_TOOLS (~$2 fal trainer cost). */
export const PERSONA_TRAINING = {
  creditCost: 350,
  providerCost: 2.0,
  minPhotos: 5,
  maxPhotos: 20,
} as const;

/** Concurrent persona slots per plan. */
export const PERSONA_SLOTS: Record<'studio' | 'pro' | 'owner', number> = {
  studio: 2,
  pro: 5,
  owner: 5,
};

export function personaGenCreditCost(): number {
  return Math.ceil((PERSONA_GEN.providerCost / (1 - STUDIO_MARGIN)) * 100);
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
export function resolutionsFor(family: ModelFamily, aspectRatio: string): FamilyOption[] {
  const all = family.capabilities.resolutions ?? [];
  const excluded = family.capabilities.resolutionExclusions?.[aspectRatio];
  if (!excluded) return all;
  return all.filter((o) => !excluded.includes(o.value));
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

/** Integer credits for one output: ceil(providerCost / (1 − margin) × 100). */
export function creditCost(family: ModelFamily, s: GenerationSettings): number {
  return Math.ceil((family.providerCost(s) / (1 - STUDIO_MARGIN)) * 100);
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
