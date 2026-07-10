import { Injectable } from '@angular/core';

const CACHE_NAME = 'vansen-media-v1';
/** Synthetic, stable cache key — signed URLs rotate, generation ids don't. */
const KEY_PREFIX = 'https://media-cache.vansen.local/';

/**
 * Client-side media cache backed by Cache Storage. Generation outputs are
 * immutable, so each one is downloaded from storage at most once per device
 * and served locally forever after — this is the main egress cost saver.
 * Falls back to direct URLs when Cache Storage is unavailable.
 */
@Injectable({ providedIn: 'root' })
export class MediaCache {
  /** Session-lived object URLs so every <img> for an id shares one blob. */
  private readonly urls = new Map<string, Promise<string>>();

  private get supported(): boolean {
    return typeof caches !== 'undefined';
  }

  /** Blob for an id; downloads once, then Cache Storage serves it. */
  async blob(id: string, remoteUrl: string): Promise<Blob> {
    if (!this.supported) return (await fetch(remoteUrl)).blob();
    const cache = await caches.open(CACHE_NAME);
    const key = KEY_PREFIX + id;
    const hit = await cache.match(key);
    if (hit) return hit.blob();
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    await cache.put(key, res.clone());
    return res.blob();
  }

  /** Object URL for <img> bindings; memoized per id for the session. */
  objectUrl(id: string, remoteUrl: string): Promise<string> {
    let promise = this.urls.get(id);
    if (!promise) {
      promise = this.blob(id, remoteUrl).then((b) => URL.createObjectURL(b));
      promise.catch(() => this.urls.delete(id)); // failed fetch may be retried
      this.urls.set(id, promise);
    }
    return promise;
  }

  /** Drop one id (deleted generations). */
  async evict(id: string): Promise<void> {
    const promise = this.urls.get(id);
    this.urls.delete(id);
    if (promise) promise.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
    if (this.supported) {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(KEY_PREFIX + id);
    }
  }

  /** Sign-out: wipe everything so media does not linger on shared machines. */
  async clear(): Promise<void> {
    for (const promise of this.urls.values()) {
      promise.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
    }
    this.urls.clear();
    if (this.supported) await caches.delete(CACHE_NAME);
  }
}
