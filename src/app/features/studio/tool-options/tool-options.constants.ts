import { FilterPreset } from '../../../core/editing/ops/filters';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';

/**
 * Static option tables for the tool strip's preset pickers (crop ratios,
 * liquify brush modes, filter looks, retouch brush modes). Pure data — no
 * behavior — so the panel component can stay focused on wiring.
 */

export interface CropPreset {
  label: string;
  /** Width / height; null = free-form. */
  value: number | null;
}

export const CROP_PRESETS: CropPreset[] = [
  { label: 'Free', value: null },
  { label: 'Square 1:1', value: 1 },
  { label: 'Post 4:5', value: 4 / 5 },
  { label: 'Story 9:16', value: 9 / 16 },
  { label: 'Desktop 16:9', value: 16 / 9 },
  { label: 'Photo 3:2', value: 3 / 2 },
];

export const LIQUIFY_MODES: { id: LiquifyMode; label: string; blurb: string }[] = [
  { id: 'push', label: 'Push', blurb: 'Drag pixels along your stroke' },
  { id: 'pinch', label: 'Slim', blurb: 'Shrink toward the brush center' },
  { id: 'bulge', label: 'Bulge', blurb: 'Expand from the brush center' },
];

export const FILTER_PRESETS: { id: FilterPreset; label: string }[] = [
  { id: 'bw', label: 'B&W' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'grain', label: 'Film Grain' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'fade', label: 'Fade' },
  { id: 'noir', label: 'Noir' },
  { id: 'matte', label: 'Matte' },
  { id: 'tealorange', label: 'Teal & Orange' },
  { id: 'goldenhour', label: 'Golden Hour' },
  { id: 'crossprocess', label: 'Cross Process' },
  { id: 'infrared', label: 'Infrared' },
  { id: 'bleach', label: 'Bleach Bypass' },
  { id: 'duotone', label: 'Duotone' },
  { id: 'clarity', label: 'Clarity' },
];

export const RETOUCH_MODES: { id: RetouchMode; label: string; blurb: string }[] = [
  { id: 'lighten', label: 'Lighten', blurb: 'Brighten where you paint (dodge)' },
  { id: 'darken', label: 'Darken', blurb: 'Deepen shadows where you paint (burn)' },
  { id: 'saturate', label: 'Saturate', blurb: 'Boost color where you paint' },
  { id: 'desaturate', label: 'Mute', blurb: 'Drain color where you paint' },
];

/** Clamp a free-typed number from a percent/degree input box. */
export function toNum(value: string, lo: number, hi: number): number {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
