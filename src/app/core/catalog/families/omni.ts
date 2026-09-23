/**
 * Google Gemini Omni Flash 1.1 video: conversational generate/edit/extend,
 * priced per output second by resolution. Entry point: OMNI. Pro-only and
 * disabled until the video rollout.
 */
import type { ModelFamily } from '../family-types';
import { AR_VIDEO } from './shared-options';

function omniRate(resolution: string | undefined): number {
  if (resolution === '360p') return 0.03;
  if (resolution === '1080p') return 0.15;
  if (resolution === '4K') return 0.3;
  return 0.1;
}

export const OMNI: ModelFamily = {
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
};
