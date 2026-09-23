/**
 * Shared scalar math for the canvas viewport's gesture helpers (pan/zoom,
 * crop). Pure, no Angular or DOM dependency.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
