import { inject, Injectable } from '@angular/core';
import { SessionLifecycle } from '../auth/session-lifecycle';

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

  constructor() {
    inject(SessionLifecycle).register('media-cache', { reset: () => this.clear() });
  }

  private get supported(): boolean {
    return typeof caches !== 'undefined';
  }

  /**
   * The cache, or null when this device will not give us one.
   *
   * A private window throws `SecurityError` from `caches.open`, and storage
   * can be blocked outright. Neither is a reason the customer cannot see
   * their own picture.
   */
  private async open(): Promise<Cache | null> {
    if (!this.supported) return null;
    try {
      return await caches.open(CACHE_NAME);
    } catch {
      return null;
    }
  }

  /** Blob for an id; downloads once, then Cache Storage serves it. */
  async blob(id: string, remoteUrl: string): Promise<Blob> {
    const cache = await this.open();
    const key = KEY_PREFIX + id;
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return hit.blob();
    const res = await fetch(remoteUrl);
    // An expired link answers with an XML error document. Caching that would
    // serve the error as the image forever.
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    try {
      await cache?.put(key, res.clone());
    } catch {
      // Quota or private mode — this session still works, and the next one
      // downloads again. Failing here would lose the image we already have.
    }
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

  /** Drop one id (deleted generations) — the full image and its grid tile. */
  async evict(id: string): Promise<void> {
    const cache = await this.open();
    for (const key of [id, `${id}:thumb`]) {
      const promise = this.urls.get(key);
      this.urls.delete(key);
      if (promise) promise.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
      await cache?.delete(KEY_PREFIX + key).catch(() => false);
    }
  }

  /** Sign-out: wipe everything so media does not linger on shared machines. */
  async clear(): Promise<void> {
    for (const promise of this.urls.values()) {
      promise.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
    }
    this.urls.clear();
    if (!this.supported) return;
    await caches.delete(CACHE_NAME).catch(() => false);
  }
}
