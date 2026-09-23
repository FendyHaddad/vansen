/**
 * The ordered list of every model family the picker and GET /catalog offer,
 * and lookup by id. Order here is the order clients render.
 * Entry points: MODEL_FAMILIES, familyById. Each family lives in families/.
 */
import type { ModelFamily } from './family-types';
import { FLUX } from './families/flux';
import { GPT_IMAGE } from './families/gpt-image';
import { KLING } from './families/kling';
import { NANO_BANANA } from './families/nano-banana';
import { OMNI } from './families/omni';
import { RUNWAY } from './families/runway';
import { SEEDANCE } from './families/seedance';
import { SEEDREAM } from './families/seedream';
import { VEO } from './families/veo';

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
