/**
 * Runway Gen-4.5 video (direct API): silent clips at one flat per-second
 * price for both resolutions. Entry point: RUNWAY. Pro-only and disabled
 * until the video rollout.
 */
import type { ModelFamily } from '../family-types.ts';
import { AR_VIDEO } from './shared-options.ts';

export const RUNWAY: ModelFamily = {
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
};
