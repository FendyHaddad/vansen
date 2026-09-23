/**
 * The ordered list of every model family the picker and GET /catalog offer,
 * and lookup by id. Order here is the order clients render.
 * Entry points: MODEL_FAMILIES, familyById. Each family lives in families/.
 */
import type { ModelFamily } from './family-types.ts';
import { FLUX } from './families/flux.ts';
import { GPT_IMAGE } from './families/gpt-image.ts';
import { KLING } from './families/kling.ts';
import { NANO_BANANA } from './families/nano-banana.ts';
import { OMNI } from './families/omni.ts';
import { RUNWAY } from './families/runway.ts';
import { SEEDANCE } from './families/seedance.ts';
import { SEEDREAM } from './families/seedream.ts';
import { VEO } from './families/veo.ts';

export const MODEL_FAMILIES: ModelFamily[] = [
  NANO_BANANA,
  GPT_IMAGE,
  FLUX,
  SEEDREAM,
  // ── Video ───────────────────────────────────────────────────────────
  VEO,
  OMNI,
  KLING,
  RUNWAY,
  SEEDANCE,
];

export function familyById(id: string): ModelFamily | undefined {
  return MODEL_FAMILIES.find((f) => f.id === id);
}
