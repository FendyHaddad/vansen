import { Injectable, inject } from '@angular/core';
import { ApiService } from '../api/api-service';
import { JobsResponse } from '../api/dtos';
import { GenerationStore } from '../generations/generation-store';

const FAST_MS = 2000;
const SLOW_MS = 5000;
const SLOW_AFTER_MS = 30_000;
const VIDEO_FAST_MS = 3000;
const VIDEO_SLOWEST_MS = 10_000;
const VIDEO_SLOWEST_AFTER_MS = 120_000;

/** Poll interval given elapsed time and whether any pending item is a video. */
export function pollIntervalMs(elapsedMs: number, hasVideo: boolean): number {
  if (!hasVideo) return elapsedMs > SLOW_AFTER_MS ? SLOW_MS : FAST_MS;
  if (elapsedMs > VIDEO_SLOWEST_AFTER_MS) return VIDEO_SLOWEST_MS;
  if (elapsedMs > SLOW_AFTER_MS) return SLOW_MS;
  return VIDEO_FAST_MS;
}

/**
 * Polls GET /jobs while the library has pending items, applying status/media
 * updates to the store. Backs off 2s → 5s after 30s (image) or
 * 3s → 5s after 30s → 10s after 2min (video); stops when none pending.
 */
@Injectable({ providedIn: 'root' })
export class JobPoller {
  private readonly api = inject(ApiService);
  private readonly store = inject(GenerationStore);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  /** Idempotent — safe to call whenever new pending items may exist. */
  watch(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const ids = this.store.pendingIds();
    if (ids.length === 0) {
      this.stop();
      return;
    }
    try {
      const response = await this.api.get<JobsResponse>(`/jobs?ids=${ids.join(',')}`);
      this.store.applyJobUpdates(response.items);
    } catch {
      // transient — next tick retries
    }
  }

  private schedule(): void {
    const elapsed = Date.now() - this.startedAt;
    const delay = pollIntervalMs(elapsed, this.store.pendingVideoCount() > 0);
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.store.pendingIds().length > 0) this.schedule();
      else this.stop();
    }, delay);
  }
}
