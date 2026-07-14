export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration';

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
    audio?: boolean;
    imageInput: boolean;
    maskInput: boolean;
  };
  providerCost(settings: GenerationSettings): number;
}

const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];
const AR_VIDEO = ['16:9', '9:16', '1:1'];

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

export const MODEL_FAMILIES: ModelFamily[] = [
  {
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
          tooltip: 'Gemini 2.5 Flash Image — quickest and cheapest, ~1K output only.',
        },
        {
          value: 'standard',
          label: 'Standard',
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
  {
    id: 'veo',
    name: 'Veo',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'video',
    blurb: 'Veo 3.1 — cinematic clips with native audio.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: 'Full quality with audio, up to 4K.' },
        { value: 'fast', label: 'Fast', tooltip: 'Quicker and cheaper, 720p/1080p only.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: '720p HD output — smaller files, faster.' },
        { value: '1080p', label: '1080p', tooltip: 'Full-HD output.' },
        { value: '4K', label: '4K', tooltip: 'Standard tier only.' },
      ],
      durations: [4, 6, 8],
      audio: true,
      imageInput: false,
      maskInput: false,
    },
    providerCost: (s) => {
      const perS = s.version === 'fast' ? 0.1 : s.resolution === '4K' ? 0.6 : 0.4;
      return perS * (s.durationS ?? 4);
    },
  },
  {
    id: 'sora',
    name: 'Sora',
    provider: 'OpenAI',
    logo: '/logos/openai.svg',
    kind: 'video',
    blurb: 'Sora 2 — strong physics and coherent motion.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: '720p, best value.' },
        { value: 'pro', label: 'Pro', tooltip: 'Higher fidelity, unlocks 1080p.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: '720p HD output — smaller files, faster.' },
        { value: '1080p', label: '1080p', tooltip: 'Pro tier only.' },
      ],
      durations: [4, 8, 12],
      imageInput: false,
      maskInput: false,
    },
    // Per-second rates derived from OpenAI per-clip pricing in the verified flat catalog
    providerCost: (s) => {
      const perS = s.version === 'pro' ? (s.resolution === '1080p' ? 0.7 : 0.3) : 0.1;
      return perS * (s.durationS ?? 4);
    },
  },
  {
    id: 'kling',
    name: 'Kling',
    provider: 'Kuaishou',
    logo: '/logos/kuaishou.svg',
    kind: 'video',
    blurb: 'Kling 2.5 Turbo Pro — best value for smooth motion.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      durations: [5, 10],
      imageInput: false,
      maskInput: false,
    },
    providerCost: (s) => 0.07 * (s.durationS ?? 5),
  },
  {
    id: 'runway',
    name: 'Runway',
    provider: 'Runway',
    logo: '/logos/runway.svg',
    kind: 'video',
    blurb: 'Gen-4.5 — director-grade control and consistency.',
    capabilities: {
      versions: [
        { value: 'gen45', label: 'Gen-4.5', tooltip: 'Flagship quality.' },
        { value: 'gen4-turbo', label: 'Gen-4 Turbo', tooltip: 'Fastest and cheapest Runway.' },
      ],
      aspectRatios: AR_VIDEO,
      durations: [5, 10],
      imageInput: false,
      maskInput: false,
    },
    providerCost: (s) => (s.version === 'gen4-turbo' ? 0.05 : 0.12) * (s.durationS ?? 5),
  },
  {
    id: 'seedance',
    name: 'Seedance',
    provider: 'ByteDance',
    logo: '/logos/bytedance.svg',
    kind: 'video',
    blurb: 'Seedance 1.0 Pro — crisp 1080p clips at fal prices.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: '720p HD output — smaller files, faster.' },
        { value: '1080p', label: '1080p', tooltip: 'Full-HD output.' },
      ],
      durations: [5, 10],
      imageInput: false,
      maskInput: false,
    },
    // fal token pricing: 1080p ≈ $0.124/s, 720p ≈ $0.054/s (verified 2026-07-05)
    providerCost: (s) => (s.resolution === '720p' ? 0.054 : 0.124) * (s.durationS ?? 5),
  },
];

/** Hidden utility model powering the Upscale action (fal clarity-upscaler). */
export const UPSCALER = {
  id: 'upscaler',
  name: 'Precision Upscale',
  providerCost: 0.04,
} as const;

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
  return {
    version: defaultVersion?.value,
    aspectRatio: c.aspectRatios[0],
    resolution: c.resolutions?.[0]?.value,
    quality: c.qualities ? 'medium' : undefined,
    durationS: c.durations?.[0],
    batch: 1,
  };
}

/** Integer credits for one output: ceil(providerCost / (1 − margin) × 100). */
export function creditCost(family: ModelFamily, s: GenerationSettings): number {
  return Math.ceil((family.providerCost(s) / (1 - STUDIO_MARGIN)) * 100);
}

export function upscaleCreditCost(): number {
  return Math.ceil((UPSCALER.providerCost / (1 - STUDIO_MARGIN)) * 100);
}
