/**
 * ByteDance Seedream (4.0, 4.5, 5.0 Lite, 5.0 Pro) on fal: a flat price per
 * image per version (5 Pro has two pixel-area tiers), and the pixel sizes each
 * version sends. Entry points: SEEDREAM, SEEDREAM_DIMS, seedreamDims.
 */
import type { GenerationSettings, ModelFamily } from '../family-types';
import { AR_IMAGE, RES_TOOLTIPS } from './shared-options';

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

export const SEEDREAM: ModelFamily = {
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
};
