// One description of "what we will actually ask the provider for", built once
// per request and used by BOTH the quote and the adapter.
//
// Before this module the two were derived independently: the catalog priced by
// version and resolution while openai.ts hard-coded one model and one size
// table keyed only on aspect ratio, so a customer paid 73 credits for the same
// request that cost another 28. Deriving them from one object makes that class
// of drift a type error instead of a billing incident.
//
// Every model id and parameter name below is copied from
// docs/superpowers/specs/2026-09-20-provider-capability-record.md via
// provider-capabilities.json. Do not add one that is not recorded there.
import {
  CATALOG_VERSION,
  creditCost,
  fluxDims,
  type GenerationSettings,
  type ModelFamily,
} from './model-families.ts';
import verified from './provider-capabilities.json' with { type: 'json' };

export const QUOTE_VERSION = 1;

/**
 * A value as the provider spells it. The object form exists because fal takes
 * `image_size` as `{width, height}` — flattening it here would mean the
 * adapter re-derived it, which is the exact split this module removes.
 */
export type ProviderValue = string | number | boolean | { width: number; height: number };

export interface NormalizedRequest {
  quoteVersion: number;
  catalogVersion: string;
  familyId: string;
  op: string;
  /** The EXACT provider model id the adapter will call. */
  providerModel: string;
  /** The EXACT axis values the adapter will transmit, already in provider spelling. */
  providerSettings: Record<string, ProviderValue>;
  /** The catalogued settings this was derived from, for storage and retry. */
  settings: GenerationSettings;
  hasReference: boolean;
  hasMask: boolean;
}

const RESOLUTION_ORDER = ['1K', '2K', '4K'];

function lookup(table: Record<string, string>, key: string, field: string): string {
  const mapped = table[key];
  if (!mapped) throw new Error(`unsupported_${field}:${key}`);
  return mapped;
}

/** "1024x768" → {width, height}, the shape fal's image_size takes. */
function dimensions(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  if (!width || !height) throw new Error(`unsupported_size:${size}`);
  return { width, height };
}

function nanoSettings(s: GenerationSettings): Record<string, ProviderValue> {
  const out: Record<string, ProviderValue> = {};
  if (s.resolution) out.image_size = String(s.resolution);
  if (s.aspectRatio) out.aspect_ratio = String(s.aspectRatio);
  return out;
}

/**
 * gpt-image-1 and 1.5 accept only the three standard sizes, so a resolution
 * above their ceiling is refused rather than quietly downgraded — charging the
 * 4K multiplier for a 1024px file is the defect this plan exists to remove.
 */
function gptSize(version: string, aspectRatio: string, resolution: string): string {
  const ceiling = lookup(verified.gptMaxResolution, version, 'version');
  const wanted = RESOLUTION_ORDER.indexOf(resolution);
  if (wanted === -1) throw new Error(`unsupported_resolution:${resolution}`);
  if (wanted > RESOLUTION_ORDER.indexOf(ceiling)) {
    throw new Error(`unsupported_resolution:${resolution}@${version}`);
  }
  if (ceiling === '1K') return lookup(verified.gptStandardSizes, aspectRatio, 'aspectRatio');
  return lookup(verified.gptSizes, `${aspectRatio}:${resolution}`, 'size');
}

function gptSettings(s: GenerationSettings): Record<string, ProviderValue> {
  const version = String(s.version ?? '2');
  return {
    size: gptSize(version, String(s.aspectRatio ?? '1:1'), String(s.resolution ?? '1K')),
    quality: String(s.quality ?? 'medium'),
  };
}

/**
 * fal takes no `aspect_ratio` on any image endpoint in this catalog — an
 * unrecognised key is dropped silently, which is why both the ratio and the
 * resolution control were dead. Both axes ride inside `image_size`.
 */
function falSettings(
  table: Record<string, string>,
  s: GenerationSettings,
  fallbackResolution: string,
): Record<string, ProviderValue> {
  const key = `${String(s.aspectRatio ?? '1:1')}:${String(s.resolution ?? fallbackResolution)}`;
  return { image_size: dimensions(lookup(table, key, 'size')) };
}

export function normalizeGenerationRequest(
  family: ModelFamily,
  op: string,
  settings: GenerationSettings,
  ctx: { hasReference: boolean; hasMask: boolean },
): NormalizedRequest {
  const base = {
    quoteVersion: QUOTE_VERSION,
    catalogVersion: CATALOG_VERSION,
    familyId: family.id,
    op,
    settings,
    hasReference: ctx.hasReference,
    hasMask: ctx.hasMask,
  };
  if (family.id === 'nano-banana') {
    return {
      ...base,
      providerModel: lookup(verified.nanoModels, String(settings.version ?? 'standard'), 'version'),
      providerSettings: nanoSettings(settings),
    };
  }
  if (family.id === 'gpt-image') {
    return {
      ...base,
      providerModel: lookup(verified.gptModels, String(settings.version ?? '2'), 'version'),
      providerSettings: gptSettings(settings),
    };
  }
  if (family.id === 'flux') {
    // The dimensions come from the catalog's own FLUX_DIMS, the same table
    // `resolutionExclusions` was derived from — so a tier we sell is always a
    // size this endpoint will actually render.
    return {
      ...base,
      providerModel: verified.fluxSlug,
      providerSettings: { image_size: fluxDims(settings) },
    };
  }
  if (family.id === 'seedream') {
    return {
      ...base,
      providerModel: verified.seedreamSlug,
      providerSettings: falSettings(verified.seedreamSizes, settings, '1K'),
    };
  }
  // Families with no verified axis mapping yet (video, persona, edit tools)
  // carry no provider settings rather than an invented one.
  return { ...base, providerModel: family.id, providerSettings: {} };
}

/**
 * The price of exactly this request. Both numbers come from the catalog so a
 * quote can never disagree with `creditCost`; the point of taking the
 * normalized request is that the caller cannot price one request and submit
 * another.
 */
export function quote(
  n: NormalizedRequest,
  family: ModelFamily,
): { credits: number; providerCostUsd: number } {
  return {
    credits: creditCost(family, n.settings),
    providerCostUsd: family.providerCost(n.settings),
  };
}
