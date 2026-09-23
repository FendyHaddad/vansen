/**
 * Black Forest Labs FLUX.2 (Pro, Flex, Max) on fal: megapixel tiers priced at
 * fal's per-megapixel rates, and the exact pixel sizes each tier sends.
 * Entry points: FLUX, FLUX_DIMS, fluxDims (used by _shared/generation-request.ts).
 */
import type { GenerationSettings, ModelFamily } from '../family-types.ts';
import { AR_IMAGE } from './shared-options.ts';

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

export const FLUX: ModelFamily = {
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
};
