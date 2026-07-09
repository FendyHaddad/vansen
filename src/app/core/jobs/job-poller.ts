import { Injectable, inject } from '@angular/core';
import { ApiService } from '../api/api-service';
import { JobsResponse } from '../api/dtos';
import { GenerationStore } from '../generations/generation-store';

const FAST_MS = 2000;
const SLOW_MS = 5000;
const SLOW_AFTER_MS = 30_000;

/**
 * Polls GET /jobs while the library has pending items, applying status/media
 * updates to the store. Backs off 2s → 5s after 30s; stops when none pending.
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
    const interval = Date.now() - this.startedAt > SLOW_AFTER_MS ? SLOW_MS : FAST_MS;
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.store.pendingIds().length > 0) {
        this.schedule();
      } else {
        this.stop();
      }
    }, interval);
  }
}
