import { describe, expect, it } from 'vitest';
import { MODEL_MANIFEST, modelFor, TOTAL_MANIFEST_BYTES } from './model-manifest';

describe('MODEL_MANIFEST', () => {
  it('every model declares a url, a byte size and a sha-256', () => {
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      expect(entry.url, id).toMatch(/^https:\/\//);
      expect(entry.bytes, id).toBeGreaterThan(0);
      expect(entry.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.license, id).toBeTruthy();
    }
  });

  it('every url is pinned to an immutable revision', () => {
    // `resolve/main` is whatever upstream pushed last. A hash measured against
    // main is a hash of something that can change without notice.
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      expect(entry.url, id).not.toContain('/resolve/main/');
      expect(entry.url, id).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    }
  });

  it('no model comes from a license-banned source', () => {
    // RMBG (bria), the AGPL ISNet mirror, GFPGAN, CodeFormer, MODNet weights
    // and CelebA face-parsing weights are non-commercial or copyleft and must
    // never ship in a paid product.
    const banned = ['briaai', 'rmbg', 'gfpgan', 'codeformer', 'modnet', 'celeba'];
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      const url = entry.url.toLowerCase();
      for (const needle of banned) {
        expect(url.includes(needle), `${id} uses a banned source: ${needle}`).toBe(false);
      }
    }
  });

  it('only commercially usable licenses appear', () => {
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      expect(['MIT', 'Apache-2.0'], id).toContain(entry.license);
    }
  });

  it('declares a warn threshold for large downloads', () => {
    const big = Object.values(MODEL_MANIFEST).filter((m) => m.bytes > 20_000_000);
    expect(big.length).toBeGreaterThan(0);
    for (const entry of big) expect(entry.warnBeforeDownload).toBe(true);
  });

  it('the whole manifest fits a realistic cache budget', () => {
    // Every model cached at once must stay inside what a browser will
    // actually grant, or the newest download silently evicts an older one.
    expect(TOTAL_MANIFEST_BYTES).toBeLessThan(400_000_000);
  });

  it('modelFor throws on an unknown id rather than fetching something', () => {
    expect(() => modelFor('nope' as never)).toThrow();
  });
});
