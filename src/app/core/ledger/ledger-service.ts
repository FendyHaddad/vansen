import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import { LedgerEntryDto, LedgerResponse } from '../api/dtos';
import { LedgerType } from '../enums';

export type { LedgerType };
export type LedgerEntry = LedgerEntryDto;

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

  readonly planCredits = computed(() => this.creditsSig().plan);
  readonly packCredits = computed(() => this.creditsSig().pack);
  readonly totalCredits = computed(() => this.creditsSig().plan + this.creditsSig().pack);
  readonly entries = this.entriesSig.asReadonly();
  readonly entriesLoaded = this.entriesLoadedSig.asReadonly();

  /** Server responses (profile load, generation create) push balances here. */
  setCredits(credits: { plan: number; pack: number }): void {
    this.creditsSig.set(credits);
  }

  async loadEntries(): Promise<void> {
    const response = await this.api.get<LedgerResponse>('/ledger');
    this.entriesSig.set(response.entries);
    this.entriesLoadedSig.set(true);
  }

  reset(): void {
    this.creditsSig.set({ plan: 0, pack: 0 });
    this.entriesSig.set([]);
    this.entriesLoadedSig.set(false);
  }
}
