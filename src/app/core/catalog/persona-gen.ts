/**
 * Personas: the hidden `persona` family (Nano Banana Pro at 4K with five
 * labelled reference photos), capture-slot rules and limits, and its price.
 * Entry points: PERSONA_GEN, PERSONA_SLOT_ORDER, personaSettings,
 * personaGenCreditCost, personaAspectRatios. Priced off Nano Banana's own table.
 */
import type { GenerationInput, GenerationSettings, ModelFamily } from './family-types';
import { STUDIO_MARGIN, providerCostWithInput } from './credit-cost';
import { resolutionsFor } from './family-options';
import { familyById } from './family-registry';

/**
 * Hidden persona family — Google Nano Banana Pro at its highest settings,
 * with the persona's five photos as references. Not in the picker; selected
 * implicitly when a persona is active. One entry, so the persona model can be
 * swapped without touching Nano Banana's own prices or kill switch.
 */
export const PERSONA_GEN = {
  id: 'persona',
  name: 'Persona',
  providerModel: 'gemini-3-pro-image',
  resolution: '4K',
  photoCount: 5,
  /** Multiplier on the margin price. Raised only if the likeness test earns it. */
  premium: 1.0,
} as const;

/** The five guided capture angles, in the order they are sent to the model. */
export const PERSONA_SLOT_ORDER = [
  'front',
  'left_three_quarter',
  'right_three_quarter',
  'left_profile',
  'right_profile',
] as const;
export type PersonaSlot = (typeof PERSONA_SLOT_ORDER)[number];

/** Concurrent persona slots per plan. */
export const PERSONA_SLOTS: Record<'studio' | 'pro' | 'owner', number> = {
  studio: 2,
  pro: 5,
  owner: 5,
};

/** What each capture slot is called on screen, in every client. */
export const PERSONA_SLOT_LABELS: Record<PersonaSlot, string> = {
  front: 'Front',
  left_three_quarter: 'Left ¾',
  right_three_quarter: 'Right ¾',
  left_profile: 'Left profile',
  right_profile: 'Right profile',
};

/** Minimum short edge of a persona photo, in pixels. Clients check it first; the gateway re-checks. */
export const PERSONA_MIN_EDGE = 1024;

/** Largest persona photo the gateway accepts, in bytes (2.5 MB). */
export const PERSONA_MAX_BYTES = 2.5 * 1024 * 1024;

/** Longest persona name the gateway accepts, after trimming. */
export const PERSONA_NAME_MAX = 40;

/** The fixed settings a persona image is rendered and priced at. */
export function personaSettings(aspectRatio: string): GenerationSettings {
  return { version: 'pro', resolution: PERSONA_GEN.resolution, aspectRatio };
}

function nanoFamily(): ModelFamily {
  const family = familyById('nano-banana');
  if (!family) throw new Error('nano-banana family missing from the catalog');
  return family;
}

/** Our provider cost for one persona image: output, thinking, five photos, prompt. */
export function personaProviderCost(): number {
  const input: GenerationInput = { hasReference: true, referenceCount: PERSONA_GEN.photoCount };
  return providerCostWithInput(nanoFamily(), personaSettings('1:1'), input);
}

export function personaGenCreditCost(): number {
  return Math.ceil(
    (personaProviderCost() / (1 - STUDIO_MARGIN)) * 100 * PERSONA_GEN.premium,
  );
}

/**
 * The ratios a persona request passes the gateway's check with: Nano Banana's
 * ratios where its Pro version renders at the persona resolution.
 */
export function personaAspectRatios(): string[] {
  const nano = nanoFamily();
  return nano.capabilities.aspectRatios.filter((ratio) =>
    resolutionsFor(nano, ratio, 'pro').some((option) => option.value === PERSONA_GEN.resolution)
  );
}
