import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { familyById } from '../../../core/catalog/model-families';

interface UsageRow {
  label: string;
  count: number;
  spendUsd: number;
  pct: number;
}

@Component({
  selector: 'app-usage-tab',
  templateUrl: './usage-tab.html',
  styleUrl: './usage-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
})
export class UsageTab {
  private readonly ledger = inject(LedgerService);

  constructor() {
    if (!this.ledger.entriesLoaded()) void this.ledger.loadEntries();
  }

  private readonly monthDebits = computed(() => {
    const now = new Date();
    return this.ledger
      .entries()
      .filter((e) => e.amountUsd < 0 && e.type !== 'studio_fee')
      .filter((e) => {
        const d = new Date(e.createdAt);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      });
  });

  readonly totalSpend = computed(() =>
    this.monthDebits().reduce((sum, e) => sum + Math.abs(e.amountUsd), 0),
  );
  readonly totalOps = computed(() => this.monthDebits().length);

  readonly byType = computed<UsageRow[]>(() => this.rowsBy((e) => e.type));

  readonly byFamily = computed<UsageRow[]>(() =>
    this.rowsBy((e) => {
      if (!e.familyId) return 'Other';
      if (e.familyId === 'upscaler' || e.familyId === 'magnific') return 'Upscale';
      return familyById(e.familyId)?.name ?? e.familyId;
    }),
  );

  private rowsBy(
    keyOf: (e: { type: string; familyId?: string | null; amountUsd: number }) => string,
  ): UsageRow[] {
    const groups = new Map<string, { count: number; spend: number }>();
    for (const e of this.monthDebits()) {
      const key = keyOf(e);
      const g = groups.get(key) ?? { count: 0, spend: 0 };
      g.count += 1;
      g.spend += Math.abs(e.amountUsd);
      groups.set(key, g);
    }
    const total = this.totalSpend() || 1;
    return [...groups.entries()]
      .map(([label, g]) => ({
        label,
        count: g.count,
        spendUsd: g.spend,
        pct: Math.round((g.spend / total) * 100),
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);
  }
}
