import { Injectable, computed, signal } from '@angular/core';

export type LedgerType = 'topup' | 'generate' | 'edit' | 'upscale' | 'studio_fee';

export interface LedgerEntry {
  id: string;
  at: string; // ISO timestamp
  type: LedgerType;
  familyId?: string;
  /** Positive = credit, negative = debit. */
  amountUsd: number;
  note?: string;
}

const STORAGE_KEY = 'vansen.ledger';

/**
 * Stub money source-of-truth. Mirrors the future Postgres `transactions` table:
 * balance is always the sum of entries, never a stored number.
 */
@Injectable({ providedIn: 'root' })
export class LedgerService {
  private readonly state = signal<LedgerEntry[]>(restore());

  readonly entries = this.state.asReadonly();
  readonly balanceUsd = computed(() =>
    round2(this.state().reduce((sum, e) => sum + e.amountUsd, 0)),
  );

  add(e: Omit<LedgerEntry, 'id' | 'at'>): void {
    const entry: LedgerEntry = { ...e, id: crypto.randomUUID(), at: new Date().toISOString() };
    this.state.update((list) => [entry, ...list]);
    persist(this.state());
  }

  /** Debit. Returns false (and does nothing) when balance is insufficient. */
  charge(type: LedgerType, amountUsd: number, familyId?: string, note?: string): boolean {
    if (this.balanceUsd() < amountUsd) return false;
    this.add({ type, familyId, note, amountUsd: -round2(amountUsd) });
    return true;
  }

  /** First $20 top-up: $15 usable, $5 covers the first Studio month. Idempotent. */
  seedIfEmpty(): void {
    if (this.state().length > 0) return;
    this.add({ type: 'topup', amountUsd: 20, note: 'First top-up' });
    this.add({ type: 'studio_fee', amountUsd: -5, note: 'Studio — first month' });
  }

  reset(): void {
    this.state.set([]);
    persist([]);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function restore(): LedgerEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function persist(entries: LedgerEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}
