/**
 * ByteDance Seedance 2.5 video on fal: clips with audio, priced per output
 * second by resolution (480p or 720p). Entry point: SEEDANCE. Pro-only and
 * disabled until the video rollout.
 */
import type { ModelFamily } from '../family-types.ts';
import { AR_VIDEO } from './shared-options.ts';

export const SEEDANCE: ModelFamily = {
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
};
