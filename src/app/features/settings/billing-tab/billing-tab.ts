import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { AuthService } from '../../../core/auth/auth-service';
import { LedgerService, LedgerEntry } from '../../../core/ledger/ledger-service';
import { familyById } from '../../../core/catalog/model-families';

const TYPE_LABELS: Record<LedgerEntry['type'], string> = {
  topup: 'Top-up',
  generate: 'Generate',
  edit: 'Edit',
  upscale: 'Upscale',
  studio_fee: 'Studio',
};

@Component({
  selector: 'app-billing-tab',
  templateUrl: './billing-tab.html',
  styleUrl: './billing-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, HlmButton, HlmBadge],
})
export class BillingTab {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);

  readonly balanceUsd = this.ledger.balanceUsd;
  readonly entries = this.ledger.entries;
  readonly studioActive = this.auth.studioActive;

  readonly topUpAmounts = [20, 50, 100];

  /** Stub renewal: one month after the latest studio_fee entry. */
  readonly renewsAt = computed(() => {
    const fee = this.entries().find((e) => e.type === 'studio_fee');
    if (!fee) return null;
    const d = new Date(fee.at);
    d.setMonth(d.getMonth() + 1);
    return d;
  });

  typeLabel(type: LedgerEntry['type']): string {
    return TYPE_LABELS[type];
  }

  abs(value: number): number {
    return Math.abs(value);
  }

  familyName(id?: string): string {
    if (!id) return '—';
    if (id === 'magnific') return 'Magnific';
    return familyById(id)?.name ?? id;
  }

  topUp(amount: number): void {
    this.ledger.add({ type: 'topup', amountUsd: amount, note: 'Top-up' });
  }

  cancelStudio(): void {
    if (
      !confirm(
        'Cancel Studio? It lapses at the end of the paid month. You get a 30-day grace period to download everything, then your library is permanently deleted. Your balance stays yours.',
      )
    ) {
      return;
    }
    this.auth.updateProfile({ studioActive: false });
  }

  reactivateStudio(): void {
    this.auth.updateProfile({ studioActive: true });
    this.ledger.add({ type: 'studio_fee', amountUsd: -5, note: 'Studio — reactivated' });
  }
}
