import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { ApiError } from '../../../core/api/api-service';
import { BillingService } from '../../../core/billing/billing-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { CREDIT_PACKS, packCredits } from '../../../core/catalog/model-families';

/** Add-on credit packs, right where the balance lives — the topbar. Same packs
 * as the Billing tab; this exists so a low balance never costs a page switch. */
@Component({
  selector: 'app-credit-packs-dialog',
  templateUrl: './credit-packs-dialog.html',
  styleUrl: './credit-packs-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgIcon],
  providers: [provideIcons({ lucideX })],
})
export class CreditPacksDialog {
  private readonly billing = inject(BillingService);
  private readonly profileStore = inject(ProfileStore);

  readonly dismissed = output<void>();

  readonly packs = CREDIT_PACKS;

  /** USD of the pack whose checkout is opening, or null when idle. */
  readonly busy = signal<number | null>(null);
  readonly error = signal('');

  /** Packs are priced by the buyer's tier — Pro gets 25% more per dollar. */
  readonly rate = computed<'studio' | 'pro'>(() =>
    this.profileStore.subscription()?.plan === 'pro' ? 'pro' : 'studio',
  );

  creditsFor(usd: number): number {
    return packCredits(usd, this.rate());
  }

  /** Dismissal is off while checkout is opening — closing mid-redirect leaves
   * the user unsure whether a payment window is about to appear. */
  close(): void {
    if (this.busy() !== null) return;
    this.dismissed.emit();
  }

  async buy(usd: number): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(usd);
    this.error.set('');
    try {
      await this.billing.buyPack(usd);
      // Success navigates to Stripe — stay busy so a second click can't fire.
    } catch (e) {
      this.busy.set(null);
      this.error.set(e instanceof ApiError ? e.message : 'Could not start checkout — try again.');
    }
  }
}
