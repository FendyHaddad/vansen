/**
 * Video-only catalog rules: which modes a family supports, how many reference
 * images each mode takes, the audio chips and the daily provider-spend cap.
 * Entry points: videoFamilySupports, referenceRule, AUDIO_OPTIONS, VIDEO_DAILY_CAP_USD.
 */
import type { FamilyOption, ModelFamily, VideoMode } from './family-types.ts';

/** Hard ceiling on provider spend for video per user per rolling 24 h. */
export const VIDEO_DAILY_CAP_USD = 40;

export function videoFamilySupports(family: ModelFamily, mode: VideoMode): boolean {
  return family.capabilities.modes?.includes(mode) ?? false;
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

/** The three audio settings a `selectable` video family offers, in chip order. */
export const AUDIO_OPTIONS: FamilyOption[] = [
  { value: 'off', label: 'Off', tooltip: 'Silent clip. Cheapest.' },
  { value: 'on', label: 'Sound', tooltip: 'Ambient sound and music.' },
  { value: 'voice', label: 'Voice', tooltip: 'Sound plus spoken dialogue.' },
];
