import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { CatalogModel, MODEL_CATALOG, ModelKind } from './model-catalog';
import {
  MarginResult,
  PricingConfig,
  marginFor,
  overheadPerCredit,
  packCredits,
  requiredCredits,
  stripeFee,
} from './pricing-engine';

interface ModelRow {
  model: CatalogModel;
  usdCost: number;
  creditsOverride: number | null;
}

interface PricedRow {
  model: CatalogModel;
  usdCost: number;
  suggestedCredits: number;
  impossible: boolean;
  chargedCredits: number;
  overridden: boolean;
  margin: MarginResult;
  status: 'profit' | 'thin' | 'loss';
}

@Component({
  selector: 'app-pricing-page',
  templateUrl: './pricing-page.html',
  styleUrl: './pricing-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PercentPipe],
})
export class PricingPage {
  readonly creditPriceUsd = signal(0.075);
  readonly targetNetMargin = signal(0.4);
  readonly stripePercent = signal(0.029);
  readonly stripeFixedUsd = signal(0.3);
  readonly packPriceUsd = signal(15);

  readonly rows = signal<ModelRow[]>(
    MODEL_CATALOG.map((model) => ({ model, usdCost: model.usdCost, creditsOverride: null })),
  );

  readonly config = computed<PricingConfig>(() => ({
    creditPriceUsd: this.creditPriceUsd(),
    targetNetMargin: this.targetNetMargin(),
    stripePercent: this.stripePercent(),
    stripeFixedUsd: this.stripeFixedUsd(),
    packPriceUsd: this.packPriceUsd(),
  }));

  readonly packCredits = computed(() => packCredits(this.config()));
  readonly packStripeFee = computed(() => stripeFee(this.config()));
  readonly creditOverhead = computed(() => overheadPerCredit(this.config()));

  readonly imageRows = computed(() => this.pricedRows('image'));
  readonly videoRows = computed(() => this.pricedRows('video'));

  readonly lossCount = computed(
    () => [...this.imageRows(), ...this.videoRows()].filter((r) => r.status === 'loss').length,
  );

  updateCost(id: string, value: string): void {
    const usdCost = Number(value);
    if (!Number.isFinite(usdCost) || usdCost < 0) return;
    this.rows.update((rows) => rows.map((r) => (r.model.id === id ? { ...r, usdCost } : r)));
  }

  updateCredits(id: string, value: string): void {
    if (value.trim() === '') {
      this.clearOverride(id);
      return;
    }
    const credits = Number(value);
    if (!Number.isFinite(credits) || credits <= 0) return;
    this.rows.update((rows) =>
      rows.map((r) => (r.model.id === id ? { ...r, creditsOverride: credits } : r)),
    );
  }

  clearOverride(id: string): void {
    this.rows.update((rows) =>
      rows.map((r) => (r.model.id === id ? { ...r, creditsOverride: null } : r)),
    );
  }

  updateNumber(target: 'creditPrice' | 'margin' | 'stripePct' | 'stripeFixed' | 'packPrice', value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (target === 'creditPrice') this.creditPriceUsd.set(parsed);
    if (target === 'margin') this.targetNetMargin.set(parsed / 100);
    if (target === 'stripePct') this.stripePercent.set(parsed / 100);
    if (target === 'stripeFixed') this.stripeFixedUsd.set(parsed);
    if (target === 'packPrice') this.packPriceUsd.set(parsed);
  }

  private pricedRows(kind: ModelKind): PricedRow[] {
    const cfg = this.config();
    return this.rows()
      .filter((r) => r.model.kind === kind)
      .map((r) => this.priceRow(r, cfg));
  }

  private priceRow(row: ModelRow, cfg: PricingConfig): PricedRow {
    const suggestedCredits = requiredCredits(row.usdCost, cfg);
    const chargedCredits = row.creditsOverride ?? (Number.isFinite(suggestedCredits) ? suggestedCredits : 0);
    const margin = marginFor(row.usdCost, chargedCredits, cfg);
    return {
      model: row.model,
      usdCost: row.usdCost,
      suggestedCredits,
      impossible: !Number.isFinite(suggestedCredits),
      chargedCredits,
      overridden: row.creditsOverride !== null,
      margin,
      status: this.statusOf(margin, cfg),
    };
  }

  private statusOf(margin: MarginResult, cfg: PricingConfig): 'profit' | 'thin' | 'loss' {
    if (margin.netUsd < 0) return 'loss';
    if (margin.netPct < cfg.targetNetMargin) return 'thin';
    return 'profit';
  }
}
