import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  CREDIT_PACKS,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PERSONA_GEN,
  PLAN_CREDITS,
  UPSCALER,
  creditCost,
  resolutionsFor,
} from './model-families';
import type { GenerationSettings, ModelFamily } from './model-families';
import { recordedCatalogFingerprint } from './catalog-fingerprint';
import { buildCatalog } from './build-catalog';
import type { ModelRow } from './build-catalog';

/**
 * Every settings combination the family actually offers. The price of each one
 * goes into the fingerprint, so a repriced tier cannot reach /catalog
 * without a version bump — the catalog's contract covers prices, not
 * just which chips exist.
 */
function offeredSettings(family: ModelFamily): GenerationSettings[] {
  const caps = family.capabilities;
  const combos: GenerationSettings[] = [];
  const versions = caps.versions?.map((v) => v.value) ?? [undefined];
  const qualities = caps.qualities?.map((q) => q.value) ?? [undefined];
  const durations = caps.durations ?? [undefined];
  for (const aspectRatio of caps.aspectRatios) {
    const resolutions = caps.resolutions
      ? resolutionsFor(family, aspectRatio).map((r) => r.value)
      : [undefined];
    for (const version of versions) {
      for (const resolution of resolutions) {
        for (const quality of qualities) {
          for (const durationS of durations) {
            combos.push({ aspectRatio, version, resolution, quality, durationS });
          }
        }
      }
    }
  }
  return combos;
}

/**
 * Every row GET /catalog reads, all switched on, so the served body below
 * carries every family, edit tool, the upscaler and the persona block.
 */
function everyRowEnabled(): ModelRow[] {
  const ids = [
    ...MODEL_FAMILIES.map((f) => f.id),
    ...EDIT_TOOLS.map((t) => t.id),
    UPSCALER.id,
    PERSONA_GEN.id,
  ];
  return ids.map((id) => ({ id, enabled: true, min_plan: 'studio' }));
}

/**
 * The whole body GET /catalog serves, minus the version string itself. Clients
 * cache that body keyed by the version (and the ETag embeds it), so any change
 * here without a bump would never reach a device that already holds a copy.
 */
function servedBody(): unknown {
  const { catalogVersion: _version, ...body } = buildCatalog(everyRowEnabled());
  return body;
}

/**
 * The catalog version is a promise to the Deno `_shared` copy and to every
 * client that sends it back. This fingerprint fails whenever the catalog's
 * shape or its prices change without a bump, so a silent divergence becomes a
 * red test on the machine that caused it.
 */
function fingerprint(): string {
  const shape = {
    families: MODEL_FAMILIES.map((f) => ({
      id: f.id,
      kind: f.kind,
      versions: f.capabilities.versions?.map((v) => v.value) ?? null,
      resolutions: f.capabilities.resolutions?.map((r) => r.value) ?? null,
      qualities: f.capabilities.qualities?.map((q) => q.value) ?? null,
      aspectRatios: f.capabilities.aspectRatios,
      durations: f.capabilities.durations ?? null,
      modes: f.capabilities.modes ?? null,
      resolutionExclusions: f.capabilities.resolutionExclusions ?? null,
      imageInput: f.capabilities.imageInput,
      maskInput: f.capabilities.maskInput,
      prices: offeredSettings(f).map((s) => creditCost(f, s)),
    })),
    editTools: EDIT_TOOLS.map((t) => ({ id: t.id, credits: t.creditCost })),
    packs: CREDIT_PACKS,
    planCredits: PLAN_CREDITS,
    served: servedBody(),
  };
  let hash = 0;
  const json = JSON.stringify(shape);
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

describe('catalog version', () => {
  it('matches the recorded fingerprint — bump CATALOG_VERSION and this value together', () => {
    // When this fails: you changed the catalog. Bump CATALOG_VERSION, re-run
    // `npm run sync-shared`, regenerate mobile's bundled catalog with
    // `npm run catalog:mobile <path>`, then paste the new fingerprint here.
    expect({ version: CATALOG_VERSION, fingerprint: fingerprint() }).toEqual({
      version: '2026-09-24.2',
      fingerprint: recordedCatalogFingerprint,
    });
  });
});
