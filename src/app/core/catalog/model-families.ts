/**
 * The model catalog's public entry point. Every web and Deno (`_shared`)
 * importer reads the catalog from this path; the pieces live in sibling files
 * (families/, credit-cost, plan-pricing, edit-tools, upscaler, persona-gen,
 * video-modes) and are re-exported here. CATALOG_VERSION stays in this file
 * because deploy.sh reads it from here.
 */

/**
 * Catalog version. Bump on ANY change to a family's id, options, prices or
 * provider mapping. GET /catalog serves it, clients send it back with a
 * request, and the gateway answers an invalid request from an older version
 * with 409 catalog_stale. `catalog-version.spec.ts` fails if the catalog
 * content hash changes without a bump.
 */
export const CATALOG_VERSION = '2026-09-23.4';

export type {
  AudioCapability,
  AudioMode,
  AxisId,
  FamilyOption,
  GenerationInput,
  GenerationSettings,
  ModelFamily,
  ModelKind,
  VideoMode,
} from './family-types';
export { NO_INPUT, PROMPT_MAX_CHARS, PROMPT_TOKEN_ALLOWANCE, referenceCountOf } from './generation-input';

export { FLUX_DIMS, fluxDims } from './families/flux';
export { SEEDREAM_DIMS, seedreamDims } from './families/seedream';
export { GPT_DEFAULT_VERSION, GPT_REFERENCE_TOKENS } from './families/gpt-image';
export { NANO_PRO_THINKING_TOKENS } from './families/nano-banana';
export { MODEL_FAMILIES, familyById } from './family-registry';
export { defaultSettings, qualitiesFor, resolutionsFor } from './family-options';

export { STUDIO_MARGIN, creditCost, providerCostWithInput } from './credit-cost';
export {
  CREDIT_PACKS,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  PLAN_PROMO_USD,
  PRO_EXTRA_CREDIT_PERCENT,
  PRO_PACK_BONUS_PERCENT,
  PRO_PURCHASE_RATE,
  PRO_SAVING_PERCENT,
  packCredits,
} from './plan-pricing';

export type { EditTool } from './edit-tools';
export { EDIT_TOOLS, editToolById } from './edit-tools';
export { UPSCALER, upscaleCreditCost } from './upscaler';

export type { PersonaSlot } from './persona-gen';
export {
  PERSONA_GEN,
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOTS,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  personaAspectRatios,
  personaGenCreditCost,
  personaProviderCost,
  personaSettings,
} from './persona-gen';

export type { ReferenceRule } from './video-modes';
export { AUDIO_OPTIONS, VIDEO_DAILY_CAP_USD, referenceRule, videoFamilySupports } from './video-modes';
