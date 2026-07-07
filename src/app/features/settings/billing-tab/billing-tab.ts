import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { LedgerService, LedgerEntry } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { familyById } from '../../../core/catalog/model-families';
import { Hint } from '../../../shared/hint/hint';

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

@Component({
  selector: 'app-billing-tab',
  templateUrl: './billing-tab.html',
  styleUrl: './billing-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, HlmBadge, Hint],
})
export class BillingTab {
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);

  readonly balanceUsd = this.ledger.balanceUsd;
  readonly entries = this.ledger.entries;
  readonly studioActive = this.profileStore.studioActive;
  readonly subscription = this.profileStore.subscription;

  constructor() {
    void this.ledger.loadEntries();
    if (!this.profileStore.loaded()) void this.profileStore.load();
  }

  typeLabel(type: LedgerEntry['type']): string {
    return TYPE_LABELS[type];
  }

  abs(value: number): number {
    return Math.abs(value);
  }

  familyName(id?: string | null): string {
    if (!id) return '—';
    if (id === 'magnific') return 'Magnific';
    return familyById(id)?.name ?? id;
  }
}
