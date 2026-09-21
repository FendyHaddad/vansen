import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedBytes,
  forgetUsage,
  MODEL_CACHE_BUDGET_BYTES,
  pinModel,
  reserveBudget,
  touchModel,
  unpinModel,
} from './model-budget';
import { TOTAL_MANIFEST_BYTES } from './model-manifest';

/** A Cache Storage stand-in that records deletions and can refuse them. */
function installCaches(opts: { failDelete?: boolean } = {}) {
  const deleted: string[] = [];
  globalThis.caches = {
    open: () =>
      Promise.resolve({
        delete: (k: string) => {
          if (opts.failDelete) return Promise.reject(new Error('locked'));
          deleted.push(String(k));
          return Promise.resolve(true);
        },
      }),
  } as never;
  return deleted;
}

const BIG = 100_000_000;

describe('model cache budget', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetUsage();
    installCaches();
  });

  it('holds every model in the manifest without evicting one', () => {
    // A budget under the manifest total means a customer who uses all the Pro
    // tools re-downloads forever.
    expect(MODEL_CACHE_BUDGET_BYTES).toBeGreaterThan(TOTAL_MANIFEST_BYTES);
  });

  it('a reservation inside the budget evicts nothing', async () => {
    const deleted = installCaches();
    touchModel('https://m/a', BIG);
    expect(await reserveBudget(BIG)).toBe(true);
    expect(deleted).toEqual([]);
  });

  it('the least recently used model goes first', async () => {
    const deleted = installCaches();
    touchModel('https://m/old', BIG);
    await new Promise((r) => setTimeout(r, 2));
    touchModel('https://m/new', BIG);
    await new Promise((r) => setTimeout(r, 2));
    touchModel('https://m/newest', BIG);

    await reserveBudget(BIG);

    expect(deleted).toEqual(['https://m/old']);
    expect(cachedBytes()).toBe(2 * BIG);
  });

  it('a model whose session is live is never evicted', async () => {
    const deleted = installCaches();
    touchModel('https://m/old', BIG);
    await new Promise((r) => setTimeout(r, 2));
    touchModel('https://m/new', BIG);
    await new Promise((r) => setTimeout(r, 2));
    touchModel('https://m/newest', BIG);
    pinModel('https://m/old');

    await reserveBudget(BIG);

    expect(deleted).toEqual(['https://m/new']);
    unpinModel('https://m/old');
  });

  it('a cache that refuses to evict does not throw', async () => {
    installCaches({ failDelete: true });
    touchModel('https://m/a', BIG);
    touchModel('https://m/b', BIG);
    touchModel('https://m/c', BIG);

    // Reported as "no room", so the caller skips the cache write and the
    // download still succeeds for this session.
    expect(await reserveBudget(BIG)).toBe(false);
    expect(cachedBytes()).toBe(3 * BIG);
  });

  it('a model larger than the whole budget is refused outright', async () => {
    expect(await reserveBudget(MODEL_CACHE_BUDGET_BYTES + 1)).toBe(false);
  });

  it('unreadable usage data degrades to an empty ledger', async () => {
    localStorage.setItem('vansen.models.usage', 'not json');
    expect(cachedBytes()).toBe(0);
    expect(await reserveBudget(BIG)).toBe(true);
  });
});
