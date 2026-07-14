import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { LedgerService, LedgerEntry } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { BillingService } from '../../../core/billing/billing-service';
import { ApiError } from '../../../core/api/api-service';
import { SubscriptionStatus } from '../../../core/enums';
import {
  CREDIT_PACKS,
  PLAN_CREDITS,
  familyById,
  packCredits,
} from '../../../core/catalog/model-families';

const TYPE_LABELS: Record<LedgerEntry['type'], string> = {
  generate: 'Generate',
  edit: 'Edit',
  upscale: 'Upscale',
  refund: 'Refund',
  pack_purchase: 'Credit pack',
  cycle_reset: 'Monthly grant',
  pack_expiry: 'Pack expiry',
  promo: 'Promo',
};

const PLAN_PRICES: Record<'studio' | 'pro', number> = { studio: 15, pro: 30 };

@Component({
  selector: 'app-billing-tab',
  templateUrl: './billing-tab.html',
  styleUrl: './billing-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, HlmBadge, HlmButton],
})
export class BillingTab {
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);
  private readonly billing = inject(BillingService);

  readonly planCredits = this.ledger.planCredits;
  readonly packCreditsBal = this.ledger.packCredits;
  readonly totalCredits = this.ledger.totalCredits;
  readonly entries = this.ledger.entries;
  readonly plan = this.profileStore.plan;
  readonly isOwner = this.profileStore.isOwner;
  readonly profileLoaded = this.profileStore.loaded;
  readonly subscription = this.profileStore.subscription;
  readonly graceDaysLeft = this.profileStore.graceDaysLeft;

  readonly packs = CREDIT_PACKS;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly reconcileResult = signal<string | null>(null);

  /** No active plan → show subscribe cards. Waits for the profile load so an
   * in-flight /profile never flashes "Inactive". */
  readonly needsPlan = computed(() => this.profileLoaded() && !this.plan());
  readonly canceledPending = computed(
    () => this.subscription()?.status === SubscriptionStatus.Canceled && !!this.plan(),
  );

  /** Subscriber-facing plan name; owner rides the hidden top tier. */
  readonly planLabel = computed(() => {
    const plan = this.plan();
    if (!plan) return 'Inactive';
    return plan === 'studio' ? 'Studio' : 'Pro';
  });

  readonly planPriceUsd = computed(() => {
    const plan = this.plan();
    return plan === 'studio' || plan === 'pro' ? PLAN_PRICES[plan] : null;
  });

  readonly planGrant = computed(() => {
    const plan = this.plan();
    return plan === 'studio' || plan === 'pro' ? PLAN_CREDITS[plan] : null;
  });

  /** Packs are priced by the buyer's tier (owner never buys). */
  readonly packRate = computed<'studio' | 'pro'>(() => (this.plan() === 'pro' ? 'pro' : 'studio'));

  constructor() {
    void this.ledger.loadEntries();
    if (!this.profileStore.loaded()) void this.profileStore.load();
  }

  creditsFor(usd: number): number {
    return packCredits(usd, this.packRate());
  }

  async subscribe(plan: 'studio' | 'pro'): Promise<void> {
    await this.run(() => this.billing.subscribe(plan));
  }

  async buyPack(usd: number): Promise<void> {
    await this.run(() => this.billing.buyPack(usd));
  }

  async portal(): Promise<void> {
    await this.run(() => this.billing.openPortal());
  }

  async reconcile(): Promise<void> {
    this.reconcileResult.set(null);
    await this.run(async () => {
      const credited = await this.billing.reconcile();
      await this.ledger.loadEntries();
      this.reconcileResult.set(
        credited > 0 ? `Restored ${credited} missing pack(s).` : 'Everything already credited.',
      );
    });
  }

  private async run(op: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await op();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Billing action failed');
    } finally {
      this.busy.set(false);
    }
  }

  typeLabel(type: LedgerEntry['type']): string {
    return TYPE_LABELS[type];
  }

  abs(value: number): number {
    return Math.abs(value);
  }

  familyName(id?: string | null): string {
    if (!id) return '—';
    if (id === 'upscaler' || id === 'magnific') return 'Upscale';
    return familyById(id)?.name ?? id;
  }
}
