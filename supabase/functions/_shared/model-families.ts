export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio';
export type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit';
export type AudioMode = 'off' | 'on' | 'voice';
export type AudioCapability = 'included' | 'none' | 'selectable';

export interface FamilyOption {
  value: string;
  label: string;
  tooltip: string;
  /** Small highlight tag rendered on the chip, e.g. "Latest". Also marks the default. */
  tag?: string;
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

// Provider cost (square, ~1K output) by version and quality — OpenAI published per-image pricing.
// v2 at 4K multiplies ×2.05 (ratio from Runway's published credit table — verify exact token math).
const GPT_COST: Record<string, Record<string, number>> = {
  '2': { low: 0.006, medium: 0.053, high: 0.211 },
  '1.5': { low: 0.009, medium: 0.034, high: 0.133 },
  '1': { low: 0.011, medium: 0.042, high: 0.167 },
};

/** Margin baked into the credit charge table. 1 credit = $0.01 of Studio retail. */
export const STUDIO_MARGIN = 0.4;

/** Monthly credit grant per subscription plan (owner is unlimited, never granted). */
export const PLAN_CREDITS = { studio: 1500, pro: 3750 } as const;

/** Monthly list price per plan, and the launch price for a first-time customer's
 * first 60 days (Stripe applies it as a $5/mo coupon — see STRIPE_LAUNCH_COUPON_ID). */
export const PLAN_PRICE_USD = { studio: 15, pro: 30 } as const;
export const PLAN_PROMO_USD = { studio: 10, pro: 25 } as const;

/** Pro buyers get 25% more credits per dollar — same jobs cost 20% less. */
export const PRO_PURCHASE_RATE = 1.25;

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
          tooltip: 'Gemini 2.5 Flash Image — quickest and cheapest, ~1K output only.',
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
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => {
      if (s.version === 'fast') return 0.039;
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
    blurb: 'Quality dial for compute effort; v2 adds true 4K and masked edits.',
    capabilities: {
      versions: [
        { value: '1', label: '1', tooltip: 'Original GPT Image, ~1K output.' },
        { value: '1.5', label: '1.5', tooltip: 'Previous generation, ~1K output.' },
        {
          value: '2',
          label: '2',
          tag: 'Latest',
          tooltip: 'Newest GPT Image. Any resolution up to 3840px, masked editing.',
        },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] + ' (GPT Image 2 only.)' },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] + ' (GPT Image 2 only.)' },
      ],
      qualities: [
        { value: 'low', label: 'Low', tooltip: GPT_QUALITY_TOOLTIPS['low'] },
        { value: 'medium', label: 'Medium', tooltip: GPT_QUALITY_TOOLTIPS['medium'] },
        { value: 'high', label: 'High', tooltip: GPT_QUALITY_TOOLTIPS['high'] },
      ],
      imageInput: true,
      maskInput: true,
    },
    providerCost: (s) => {
      const base = GPT_COST[s.version ?? '2']?.[s.quality ?? 'medium'] ?? 0.053;
      const mult = (s.version ?? '2') === '2' && s.resolution === '4K' ? 2.05 : 1;
      return base * mult;
    },
  },
  {
    id: 'flux',
    name: 'FLUX',
    provider: 'Black Forest Labs',
    logo: '/logos/bfl.svg',
    kind: 'image',
    blurb: 'FLUX.2 [pro] — photoreal detail, priced per megapixel.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1MP', label: '1MP', tooltip: '~1024×1024 pixels. FLUX bills per megapixel.' },
        { value: '2MP', label: '2MP', tooltip: '~1448×1448 pixels equivalent.' },
        { value: '4MP', label: '4MP', tooltip: '~2048×2048 pixels equivalent.' },
      ],
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => ({ '1MP': 0.03, '2MP': 0.06, '4MP': 0.12 }[s.resolution ?? '1MP'] ?? 0.03),
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

export function defaultSettings(family: ModelFamily): GenerationSettings {
  const c = family.capabilities;
  const defaultVersion = c.versions?.find((v) => v.tag === 'Latest') ?? c.versions?.[0];
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
