import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { loadModelBytes } from './model-loader';
import { forgetConsent, setModelConsent } from './model-consent';
import type { ModelEntry } from './model-manifest';

const progress = signal<number | null>(null);

function entry(bytes: Uint8Array, sha256: string): ModelEntry {
  return {
    url: 'https://example.test/model.onnx',
    bytes: bytes.length,
    sha256,
    license: 'MIT',
    warnBeforeDownload: false,
    label: 'Test model',
  };
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A Cache Storage stand-in that records what it was asked to delete. */
function fakeCaches(hit: Uint8Array | null) {
  const deleted: string[] = [];
  const put: string[] = [];
  globalThis.caches = {
    open: () =>
      Promise.resolve({
        match: () => Promise.resolve(hit ? new Response(hit as BodyInit) : undefined),
        put: (k: string) => {
          put.push(String(k));
          return Promise.resolve();
        },
        delete: (k: string) => {
          deleted.push(String(k));
          return Promise.resolve(true);
        },
      }),
  } as never;
  return { deleted, put };
}

describe('loadModelBytes integrity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    progress.set(null);
    // Default: nothing cached, so each test opts into a cache explicitly.
    globalThis.caches = undefined as never;
    forgetConsent();
    setModelConsent(null);
  });

  it('accepts bytes whose hash matches', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(bytes as BodyInit)) as never;
    const out = await loadModelBytes(entry(bytes, await sha(bytes)), progress);
    expect(out.length).toBe(4);
  });

  it('R18: rejects bytes whose hash does not match', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(bytes as BodyInit)) as never;
    await expect(loadModelBytes(entry(bytes, 'a'.repeat(64)), progress)).rejects.toThrow(
      /integrity/i,
    );
  });

  it('R18: rejects a response whose size does not match before hashing it', async () => {
    // A 2 GB response should be refused on its Content-Length, not buffered
    // into memory and then hashed.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bytes as BodyInit, { headers: { 'Content-Length': '999999999' } }),
    ) as never;
    await expect(loadModelBytes(entry(bytes, await sha(bytes)), progress)).rejects.toThrow(
      /size/i,
    );
  });

  it('R18: a body that outgrows the declared size is cut off, not buffered', async () => {
    // No Content-Length to check, so the only defence is the running total.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) return controller.close();
        controller.enqueue(new Uint8Array(1024));
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(stream)) as never;

    await expect(
      loadModelBytes(entry(new Uint8Array(4), 'a'.repeat(64)), progress),
    ).rejects.toThrow(/size/i);
    expect(pulls).toBeLessThan(10);
  });

  it('R18: a failed integrity check evicts the cached copy', async () => {
    // Otherwise a poisoned cache entry is served forever without a network
    // request, so the check never runs again.
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const cache = fakeCaches(bytes);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;

    await expect(loadModelBytes(entry(bytes, 'b'.repeat(64)), progress)).rejects.toThrow();
    expect(cache.deleted.length).toBe(1);
  });

  it('R18: a cached copy that still verifies is used without a fetch', async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    fakeCaches(bytes);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const out = await loadModelBytes(entry(bytes, await sha(bytes)), progress);
    expect(out.length).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('R18: a declined large download never reaches the network', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    setModelConsent(() => Promise.resolve(false));

    const big = { ...entry(bytes, await sha(bytes)), warnBeforeDownload: true };
    await expect(loadModelBytes(big, progress)).rejects.toThrow(/declined/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports progress and clears it on failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
    await expect(
      loadModelBytes(entry(new Uint8Array(4), 'c'.repeat(64)), progress),
    ).rejects.toThrow();
    expect(progress()).toBeNull();
  });

  it('clears progress after a successful download too', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(bytes as BodyInit)) as never;
    await loadModelBytes(entry(bytes, await sha(bytes)), progress);
    expect(progress()).toBeNull();
  });
});
