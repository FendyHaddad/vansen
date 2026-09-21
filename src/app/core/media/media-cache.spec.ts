import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MediaCache } from './media-cache';

/**
 * R17/R18: personal media has to work where Cache Storage does not.
 *
 * A private window throws on `caches.open`, a full device throws on `put`,
 * and a device with storage blocked has no `caches` at all. Each of those
 * used to take the image with it.
 */
describe('MediaCache without a usable cache', () => {
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;

  function make(): MediaCache {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(MediaCache);
  }

  function respondWith(body: string): ReturnType<typeof vi.fn> {
    const spy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    globalThis.fetch = spy as never;
    return spy;
  }

  beforeEach(() => {
    globalThis.caches = undefined as never;
  });

  afterEach(() => {
    globalThis.caches = realCaches;
    globalThis.fetch = realFetch;
  });

  it('a private window that refuses caches.open still shows the image', async () => {
    globalThis.caches = {
      open: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    } as never;
    const fetchSpy = respondWith('pixels');

    const blob = await make().blob('g1', 'https://media/g1.png');
    expect(await blob.text()).toBe('pixels');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a full device that refuses put still shows the image, and fetches once', async () => {
    globalThis.caches = {
      open: () =>
        Promise.resolve({
          match: () => Promise.resolve(undefined),
          put: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
          delete: () => Promise.resolve(true),
        }),
    } as never;
    const fetchSpy = respondWith('pixels');

    const blob = await make().blob('g1', 'https://media/g1.png');
    expect(await blob.text()).toBe('pixels');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a cache that cannot be read falls through to the network', async () => {
    globalThis.caches = {
      open: () =>
        Promise.resolve({
          match: () => Promise.reject(new Error('corrupt index')),
          put: () => Promise.resolve(),
          delete: () => Promise.resolve(true),
        }),
    } as never;
    respondWith('pixels');

    expect(await (await make().blob('g1', 'https://media/g1.png')).text()).toBe('pixels');
  });

  it('a 403 fails visibly instead of caching an error document as an image', async () => {
    const puts: string[] = [];
    globalThis.caches = {
      open: () =>
        Promise.resolve({
          match: () => Promise.resolve(undefined),
          put: (k: string) => {
            puts.push(String(k));
            return Promise.resolve();
          },
          delete: () => Promise.resolve(true),
        }),
    } as never;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<Error>expired</Error>', { status: 403 })) as never;

    await expect(make().blob('g1', 'https://media/g1.png')).rejects.toThrow(/403/);
    expect(puts).toEqual([]);
  });

  it('a failed load is not memoized — the next attempt tries again', async () => {
    const cache = make();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
    await expect(cache.objectUrl('g1', 'https://media/g1.png')).rejects.toThrow();

    respondWith('pixels');
    // A memoized rejection would keep failing after the network came back.
    await expect(cache.objectUrl('g1', 'https://media/g1.png')).resolves.toBeTruthy();
  });
});

describe('MediaCache eviction', () => {
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.caches = realCaches;
    globalThis.fetch = realFetch;
  });

  it('a deleted generation takes its tile with it', async () => {
    const deleted: string[] = [];
    globalThis.caches = {
      open: () =>
        Promise.resolve({
          match: () => Promise.resolve(undefined),
          put: () => Promise.resolve(),
          delete: (k: string) => {
            deleted.push(String(k));
            return Promise.resolve(true);
          },
        }),
    } as never;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    await TestBed.inject(MediaCache).evict('g1');

    // Two entries: the original and the grid thumbnail cached beside it.
    expect(deleted.length).toBe(2);
    expect(deleted.some((k) => k.endsWith(':thumb'))).toBe(true);
  });
});
