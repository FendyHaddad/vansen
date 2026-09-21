import { VIDEO_DAILY_CAP_USD, type ModelFamily } from './model-families.ts';

export const MAX_PENDING_VIDEO_JOBS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_EXPECTED_S = 30;

/** Single source of truth lives in the Angular catalog master. */
export { referenceRule, type ReferenceRule } from './model-families.ts';

export function videoJobCapReached(pendingCount: number): boolean {
  return pendingCount >= MAX_PENDING_VIDEO_JOBS;
}

export function dailyCapState(
  spentUsd: number,
  oldestChargeAt: Date | null,
  now: Date,
): { blocked: boolean; resetsAt: string | null } {
  if (spentUsd < VIDEO_DAILY_CAP_USD) return { blocked: false, resetsAt: null };
  const anchor = oldestChargeAt ?? now;
  return { blocked: true, resetsAt: new Date(anchor.getTime() + DAY_MS).toISOString() };
}

export function expectedSecondsFor(family: ModelFamily, durationS: number | undefined): number {
  const perS = family.capabilities.expectedSPerS;
  const dur = durationS ?? family.capabilities.durations?.[0] ?? 5;
  if (!perS) return FALLBACK_EXPECTED_S;
  return perS * dur;
}

/**
 * Modes where the input frame decides the output shape.
 *
 * The composer hides the aspect control in these modes, but the value was
 * still being transmitted — so a 16:9 default could fight a portrait first
 * frame, and the provider resolved that however it liked. Send nothing and
 * let the frame speak.
 */
export const FRAME_DRIVEN_MODES: ReadonlySet<string> = new Set(['i2v', 'keyframes']);

/** True when this mode's shape comes from its reference frame, not a setting. */
export function frameDrivenShape(mode: string | undefined): boolean {
  return FRAME_DRIVEN_MODES.has(mode ?? 't2v');
}
