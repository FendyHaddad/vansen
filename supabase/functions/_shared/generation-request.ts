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
  GPT_DEFAULT_VERSION,
  providerCostWithInput,
  seedreamDims,
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

function lookup(table: Record<string, string>, key: string, field: string): string {
  const mapped = table[key];
  if (!mapped) throw new Error(`unsupported_${field}:${key}`);
  return mapped;
}

function nanoSettings(s: GenerationSettings): Record<string, ProviderValue> {
  const out: Record<string, ProviderValue> = {};
  if (s.resolution) out.image_size = String(s.resolution);
  if (s.aspectRatio) out.aspect_ratio = String(s.aspectRatio);
  return out;
}

/**
 * Both offered GPT Image models take arbitrary sizes, so every tier maps to a
 * measured size. An unknown key is a refusal, never a fallback: the size we
 * send is the size we priced.
 */
function gptSettings(s: GenerationSettings): Record<string, ProviderValue> {
  const key = `${String(s.aspectRatio ?? '1:1')}:${String(s.resolution ?? '1K')}`;
  return {
    size: lookup(verified.gptSizes, key, 'size'),
    quality: String(s.quality ?? 'medium'),
  };
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
      providerModel: lookup(
        verified.gptModels,
        String(settings.version ?? GPT_DEFAULT_VERSION),
        'version',
      ),
      providerSettings: gptSettings(settings),
    };
  }
  if (family.id === 'flux') {
    // The dimensions come from the catalog's own FLUX_DIMS, the same table
    // `resolutionExclusions` was derived from — so a tier we sell is always a
    // size this endpoint will actually render. fal takes no `aspect_ratio` on
    // any image endpoint; the ratio rides inside `image_size`.
    return {
      ...base,
      providerModel: lookup(verified.fluxModels, String(settings.version ?? 'dev'), 'version'),
      providerSettings: { image_size: fluxDims(settings) },
    };
  }
  if (family.id === 'seedream') {
    // A reference is a sibling endpoint on every Seedream version, chosen here
    // so the adapter never has to know which version has which edit slug.
    const endpoints = verified.seedreamModels[
      String(settings.version ?? '4') as keyof typeof verified.seedreamModels
    ];
    if (!endpoints) throw new Error(`unsupported_version:${settings.version}`);
    return {
      ...base,
      providerModel: ctx.hasReference ? endpoints.edit : endpoints.generate,
      providerSettings: { image_size: seedreamDims(settings) },
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
 * another. The reference flag is part of the price: token-billed providers
 * charge for the image input, so a request with a reference costs more than
 * the same settings without one.
 */
export function quote(
  n: NormalizedRequest,
  family: ModelFamily,
): { credits: number; providerCostUsd: number } {
  const input = { hasReference: n.hasReference };
  return {
    credits: creditCost(family, n.settings, input),
    providerCostUsd: providerCostWithInput(family, n.settings, input),
  };
}
