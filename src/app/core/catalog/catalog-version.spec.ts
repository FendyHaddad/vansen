import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  CREDIT_PACKS,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PLAN_CREDITS,
} from './model-families';
import { recordedCatalogFingerprint } from './catalog-fingerprint';

/**
 * The catalog version is a promise to two other codebases: the Deno `_shared`
 * copy and the Flutter fixture. This fingerprint fails whenever the catalog's
 * shape changes without a bump, so a silent divergence becomes a red test on
 * the machine that caused it.
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
      imageInput: f.capabilities.imageInput,
      maskInput: f.capabilities.maskInput,
    })),
    editTools: EDIT_TOOLS.map((t) => ({ id: t.id, credits: t.creditCost })),
    packs: CREDIT_PACKS,
    planCredits: PLAN_CREDITS,
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
    // `npm run sync-shared` and `npm run export-catalog`, hand the new Dart
    // fixture to the mobile repo, then paste the new fingerprint here.
    expect({ version: CATALOG_VERSION, fingerprint: fingerprint() }).toEqual({
      version: '2026-09-20.2',
      fingerprint: recordedCatalogFingerprint,
    });
  });
});
