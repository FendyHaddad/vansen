/**
 * Kuaishou Kling 3.0 Pro video on fal: the one family with selectable audio
 * (off, sound, voice), priced per output second by audio choice.
 * Entry point: KLING. Pro-only and disabled until the video rollout.
 */
import type { AudioMode, ModelFamily } from '../family-types.ts';
import { AR_VIDEO } from './shared-options.ts';

function klingRate(audio: AudioMode | undefined): number {
  if (audio === 'voice') return 0.196;
  if (audio === 'on') return 0.168;
  return 0.112;
}

export const KLING: ModelFamily = {
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
};
