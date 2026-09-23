import { Injectable, computed, inject, signal } from '@angular/core';
import { SessionLifecycle } from '../auth/session-lifecycle';
import { ApiService } from '../api/api-service';
import { LedgerEntryDto, LedgerResponse } from '../api/dtos';
import { LedgerType } from '../enums';

export type { LedgerType };
export type LedgerEntry = LedgerEntryDto;

/** Matches the gateway's own default; the server clamps anything larger. */
export const PAGE_SIZE = 50;

/** Same cap as the mobile client: a cursor that never ends cannot loop the usage tab. */
export const MAX_MONTH_PAGES = 20;

/**
 * API-backed money view. Balance is whatever the server last said —
 * no client-side money math anywhere.
 */
@Injectable({ providedIn: 'root' })
export class LedgerService {
  private readonly api = inject(ApiService);

  private readonly creditsSig = signal<{ plan: number; pack: number }>({ plan: 0, pack: 0 });
  private readonly entriesSig = signal<LedgerEntryDto[]>([]);
  private readonly entriesLoadedSig = signal(false);
  private readonly cursorSig = signal<string | null>(null);
  private readonly loadingMoreSig = signal(false);

  readonly planCredits = computed(() => this.creditsSig().plan);
  readonly packCredits = computed(() => this.creditsSig().pack);
  readonly totalCredits = computed(() => this.creditsSig().plan + this.creditsSig().pack);
  readonly entries = this.entriesSig.asReadonly();
  readonly entriesLoaded = this.entriesLoadedSig.asReadonly();
  readonly loadingMore = this.loadingMoreSig.asReadonly();
  readonly hasMore = computed(() => this.cursorSig() !== null);

  constructor() {
    inject(SessionLifecycle).register('ledger', this);
  }

  /** Server responses (profile load, generation create) push balances here. */
  setCredits(credits: { plan: number; pack: number }): void {
    this.creditsSig.set(credits);
  }

  async loadEntries(): Promise<void> {
    const response = await this.api.get<LedgerResponse>(`/ledger?limit=${PAGE_SIZE}`);
    this.entriesSig.set(response.entries);
    this.cursorSig.set(response.nextCursor);
    this.entriesLoadedSig.set(true);
  }

  /**
   * The next page of history, appended.
   *
   * The server used to truncate at 100 entries, so an account with more
   * history simply could not see its oldest charges. Ids are de-duplicated
   * because an entry written between two pages can appear in both.
   */
  async loadMoreEntries(): Promise<void> {
    const cursor = this.cursorSig();
    if (!cursor || this.loadingMoreSig()) return;
    this.loadingMoreSig.set(true);
    try {
      const response = await this.api.get<LedgerResponse>(
        `/ledger?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      this.entriesSig.update((list) => {
        const seen = new Set(list.map((e) => e.id));
        return [...list, ...response.entries.filter((e) => !seen.has(e.id))];
      });
      this.cursorSig.set(response.nextCursor);
    } finally {
      this.loadingMoreSig.set(false);
    }
  }

  /**
   * Every entry of the current month, for the usage tab.
   *
   * One page of 50 undercounted a busy month. Pages until the oldest loaded
   * entry predates the first of the month, the server runs out, or the cap.
   */
  async loadCurrentMonth(now = new Date()): Promise<void> {
    if (!this.entriesLoadedSig()) await this.loadEntries();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let page = 1; page < MAX_MONTH_PAGES; page += 1) {
      if (!this.hasMore()) return;
      if (this.oldestPredates(monthStart)) return;
      await this.loadMoreEntries();
    }
  }

  private oldestPredates(start: Date): boolean {
    const oldest = this.entriesSig().at(-1);
    if (!oldest) return false;
    return new Date(oldest.createdAt) < start;
  }

  reset(): void {
    this.creditsSig.set({ plan: 0, pack: 0 });
    this.entriesSig.set([]);
    this.entriesLoadedSig.set(false);
    this.cursorSig.set(null);
    this.loadingMoreSig.set(false);
  }
}
