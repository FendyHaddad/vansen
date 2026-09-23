/**
 * Google Veo 3.1 video (Standard, Fast, Lite): priced per output second by
 * version and resolution. Entry point: VEO. Pro-only and disabled until the
 * video rollout (see the release runbook).
 */
import type { ModelFamily } from '../family-types.ts';
import { AR_VIDEO } from './shared-options.ts';

function veoRate(version: string | undefined, resolution: string | undefined): number {
  if (version === 'lite' && resolution === '1080p') return 0.08;
  if (version === 'lite') return 0.05;
  if (version === 'fast' && resolution === '4K') return 0.3;
  if (version === 'fast' && resolution === '1080p') return 0.12;
  if (version === 'fast') return 0.1;
  if (resolution === '4K') return 0.6;
  return 0.4;
}

export const VEO: ModelFamily = {
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
};
