/**
 * The GET /catalog payload: every live model family, the options it offers,
 * every valid combination with its exact price, and the fixed-price items.
 * MASTER copy — `npm run sync-shared` writes the Deno copy the gateway serves.
 * Pure: besides the catalog files, the only input is the `models` table rows.
 */
import {
  AUDIO_OPTIONS,
  CATALOG_VERSION,
  creditCost,
  defaultSettings,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PERSONA_GEN,
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PERSONA_SLOTS,
  personaAspectRatios,
  personaGenCreditCost,
  qualitiesFor,
  referenceRule,
  resolutionsFor,
  UPSCALER,
  upscaleCreditCost,
} from './model-families';
import type {
  AudioMode,
  FamilyOption,
  GenerationInput,
  GenerationSettings,
  ModelFamily,
  ModelKind,
  PersonaSlot,
} from './model-families';
import { STYLE_CATEGORY_TITLES, STYLE_PRESETS } from './style-presets';
import { TREND_PRESETS } from './trend-presets';
import { ENTITLEMENTS } from './entitlements';

export type CatalogControl = 'choice' | 'aspectRatio' | 'toggle' | 'duration';
export type CatalogAxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'durationS' | 'audio';
export type CatalogSettings = Partial<Record<CatalogAxisId, string | number>>;
export type CatalogPlan = 'studio' | 'pro';

export interface CatalogValue {
  value: string | number;
  label: string;
  tooltip?: string;
  tag?: string;
}

export interface CatalogAxis {
  id: CatalogAxisId;
  label: string;
  control: CatalogControl;
  values: CatalogValue[];
}

/** One valid combination. `credits[n]` is the price of ONE output with n references. */
export interface CatalogCombo {
  settings: CatalogSettings;
  credits: number[];
}

export interface CatalogFamily {
  id: string;
  label: string;
  provider: string;
  blurb: string;
  kind: ModelKind;
  enabled: boolean;
  plan: CatalogPlan;
  maxReferences: number;
  maskInput: boolean;
  axes: CatalogAxis[];
  defaults: CatalogSettings & { batch: number };
  batch: { min: number; max: number };
  combos: CatalogCombo[];
}

export interface CatalogEditTool {
  id: string;
  label: string;
  credits: number;
  enabled: boolean;
  plan: CatalogPlan;
}

/** Every persona rule the gateway enforces, so a client renders them instead of copying them. */
export interface CatalogPersona {
  creditsPerImage: number;
  enabled: boolean;
  photoSlots: { id: PersonaSlot; label: string }[];
  minEdge: number;
  maxBytes: number;
  maxNameLength: number;
  planSlots: Record<'studio' | 'pro' | 'owner', number>;
  aspectRatios: string[];
  batch: { min: number; max: number };
}

export interface Catalog {
  catalogVersion: string;
  families: CatalogFamily[];
  flat: {
    editTools: CatalogEditTool[];
    upscale: { credits: number; enabled: boolean; plan: CatalogPlan };
    persona: CatalogPersona;
  };
  styles: { id: string; label: string; category: string; categoryLabel: string; thumb: string }[];
  trends: { id: string; label: string; prompt: string; aspectRatio: string | null; thumb: string }[];
  toolPlans: Record<string, CatalogPlan>;
}

/** A `public.models` row as the gateway reads it. A missing row means off. */
export interface ModelRow {
  id: string;
  enabled: boolean;
  min_plan?: string | null;
}

/** The gateway refuses a batch above four (`invalid_batch`). */
export const IMAGE_BATCH_MAX = 4;

const AXIS_LABELS: Record<CatalogAxisId, string> = {
  version: 'Version',
  aspectRatio: 'Aspect ratio',
  resolution: 'Resolution',
  quality: 'Quality',
  durationS: 'Duration',
  audio: 'Audio',
};

export function toGenerationSettings(s: CatalogSettings): GenerationSettings {
  const settings: GenerationSettings = { aspectRatio: String(s.aspectRatio) };
  if (s.version !== undefined) settings.version = String(s.version);
  if (s.resolution !== undefined) settings.resolution = String(s.resolution);
  if (s.quality !== undefined) settings.quality = String(s.quality);
  if (s.durationS !== undefined) settings.durationS = Number(s.durationS);
  if (s.audio !== undefined) settings.audio = String(s.audio) as AudioMode;
  return settings;
}

export function referenceInput(count: number): GenerationInput {
  return { hasReference: count > 0, referenceCount: count };
}

function planOf(row: ModelRow | undefined): CatalogPlan {
  return row?.min_plan === 'pro' ? 'pro' : 'studio';
}

function fromOptions(options: FamilyOption[]): CatalogValue[] {
  return options.map((o) =>
    o.tag
      ? { value: o.value, label: o.label, tooltip: o.tooltip, tag: o.tag }
      : { value: o.value, label: o.label, tooltip: o.tooltip }
  );
}

function axis(id: CatalogAxisId, control: CatalogControl, values: CatalogValue[]): CatalogAxis {
  return { id, label: AXIS_LABELS[id], control, values };
}

function axesOf(family: ModelFamily): CatalogAxis[] {
  const caps = family.capabilities;
  const axes: CatalogAxis[] = [];
  if (caps.versions) axes.push(axis('version', 'choice', fromOptions(caps.versions)));
  axes.push(axis('aspectRatio', 'aspectRatio', caps.aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))));
  if (caps.resolutions) axes.push(axis('resolution', 'choice', fromOptions(caps.resolutions)));
  if (caps.qualities) axes.push(axis('quality', 'choice', fromOptions(caps.qualities)));
  if (caps.durations) {
    axes.push(axis('durationS', 'duration', caps.durations.map((d) => ({ value: d, label: `${d}s` }))));
  }
  if (caps.audio === 'selectable') axes.push(axis('audio', 'choice', fromOptions(AUDIO_OPTIONS)));
  return axes;
}

/** The values one axis offers once the earlier axes are chosen. */
function valuesAt(family: ModelFamily, current: CatalogAxis, chosen: CatalogSettings): (string | number)[] {
  const version = chosen.version === undefined ? undefined : String(chosen.version);
  if (current.id === 'resolution') {
    return resolutionsFor(family, String(chosen.aspectRatio), version).map((o) => o.value);
  }
  if (current.id === 'quality') return qualitiesFor(family, version).map((o) => o.value);
  return current.values.map((v) => v.value);
}

function settingsOf(
  family: ModelFamily,
  axes: CatalogAxis[],
  index = 0,
  chosen: CatalogSettings = {},
): CatalogSettings[] {
  if (index === axes.length) return [chosen];
  const current = axes[index];
  return valuesAt(family, current, chosen).flatMap((value) =>
    settingsOf(family, axes, index + 1, { ...chosen, [current.id]: value })
  );
}

function maxReferencesOf(family: ModelFamily): number {
  if (family.kind === 'image') return family.capabilities.imageInput ? 1 : 0;
  const maxima = (family.capabilities.modes ?? []).map((mode) => referenceRule(mode).max);
  return Math.max(0, ...maxima);
}

function combosOf(family: ModelFamily, axes: CatalogAxis[], maxReferences: number): CatalogCombo[] {
  const counts = Array.from({ length: maxReferences + 1 }, (_, n) => n);
  return settingsOf(family, axes).map((settings) => ({
    settings,
    credits: counts.map((n) => creditCost(family, toGenerationSettings(settings), referenceInput(n))),
  }));
}

function defaultsOf(family: ModelFamily, axes: CatalogAxis[]): CatalogSettings & { batch: number } {
  const settings = defaultSettings(family) as unknown as Record<string, unknown>;
  const picked: CatalogSettings = {};
  for (const current of axes) {
    const value = settings[current.id];
    if (typeof value === 'string' || typeof value === 'number') picked[current.id] = value;
  }
  return { ...picked, batch: 1 };
}

function familyEntry(family: ModelFamily, row: ModelRow | undefined): CatalogFamily {
  const axes = axesOf(family);
  const maxReferences = maxReferencesOf(family);
  return {
    id: family.id,
    label: family.name,
    provider: family.provider,
    blurb: family.blurb,
    kind: family.kind,
    enabled: row?.enabled === true,
    plan: planOf(row),
    maxReferences,
    maskInput: family.capabilities.maskInput,
    axes,
    defaults: defaultsOf(family, axes),
    batch: { min: 1, max: family.kind === 'video' ? 1 : IMAGE_BATCH_MAX },
    combos: combosOf(family, axes, maxReferences),
  };
}

function personaEntry(row: ModelRow | undefined): CatalogPersona {
  return {
    creditsPerImage: personaGenCreditCost(),
    enabled: row?.enabled === true,
    photoSlots: PERSONA_SLOT_ORDER.map((id) => ({ id, label: PERSONA_SLOT_LABELS[id] })),
    minEdge: PERSONA_MIN_EDGE,
    maxBytes: PERSONA_MAX_BYTES,
    maxNameLength: PERSONA_NAME_MAX,
    planSlots: { ...PERSONA_SLOTS },
    aspectRatios: personaAspectRatios(),
    batch: { min: 1, max: IMAGE_BATCH_MAX },
  };
}

export function buildCatalog(rows: ModelRow[], families: ModelFamily[] = MODEL_FAMILIES): Catalog {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    catalogVersion: CATALOG_VERSION,
    families: families.map((family) => familyEntry(family, byId.get(family.id))),
    flat: {
      editTools: EDIT_TOOLS.map((tool) => ({
        id: tool.id,
        label: tool.name,
        credits: tool.creditCost,
        enabled: byId.get(tool.id)?.enabled === true,
        plan: planOf(byId.get(tool.id)),
      })),
      upscale: {
        credits: upscaleCreditCost(),
        enabled: byId.get(UPSCALER.id)?.enabled === true,
        plan: planOf(byId.get(UPSCALER.id)),
      },
      persona: personaEntry(byId.get(PERSONA_GEN.id)),
    },
    styles: STYLE_PRESETS.map((s) => ({
      id: s.id,
      label: s.name,
      category: s.category,
      categoryLabel: STYLE_CATEGORY_TITLES[s.category],
      thumb: s.thumb,
    })),
    trends: TREND_PRESETS.map((t) => ({
      id: t.id,
      label: t.name,
      prompt: t.prompt,
      aspectRatio: t.aspectRatio ?? null,
      thumb: t.thumb,
    })),
    toolPlans: { ...ENTITLEMENTS },
  };
}
