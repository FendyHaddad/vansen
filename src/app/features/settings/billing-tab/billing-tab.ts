import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { LedgerService, LedgerEntry } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { BillingService } from '../../../core/billing/billing-service';
import { ApiError } from '../../../core/api/api-service';
import { SubscriptionStatus } from '../../../core/enums';
import { familyById } from '../../../core/catalog/model-families';

const TYPE_LABELS: Record<LedgerEntry['type'], string> = {
  topup: 'Top-up',
  generate: 'Generate',
  edit: 'Edit',
  upscale: 'Upscale',
  studio_fee: 'Studio',
  trial_credit: 'Trial',
  promo: 'Promo',
  refund: 'Refund',
};

const TOPUP_PRESETS = [10, 20, 50, 100];

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

  readonly balanceUsd = this.ledger.balanceUsd;
  readonly entries = this.ledger.entries;
  readonly studioActive = this.profileStore.studioActive;
  readonly subscription = this.profileStore.subscription;
  readonly graceDaysLeft = this.profileStore.graceDaysLeft;

  readonly presets = TOPUP_PRESETS;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly reconcileResult = signal<string | null>(null);

  /** No active Studio → first purchase carries the $5 Studio line. */
  readonly needsStudio = computed(() => !this.studioActive());
  readonly canceledPending = computed(
    () => this.subscription()?.status === SubscriptionStatus.Canceled && this.studioActive(),
  );

  constructor() {
    void this.ledger.loadEntries();
    if (!this.profileStore.loaded()) void this.profileStore.load();
  }

  dueFor(credits: number): number {
    return this.needsStudio() ? credits + 5 : credits;
  }

  async topUp(credits: number): Promise<void> {
    await this.run(() => this.billing.checkout(credits));
  }

  async reactivate(): Promise<void> {
    await this.run(() => this.billing.reactivateStudio());
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
        credited > 0 ? `Restored ${credited} missing top-up(s).` : 'Everything already credited.',
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
