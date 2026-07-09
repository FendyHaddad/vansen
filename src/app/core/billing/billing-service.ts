import { Injectable, InjectionToken, inject } from '@angular/core';
import { ApiService } from '../api/api-service';
import { CheckoutRequest, CheckoutResponse, ReconcileResponse } from '../api/dtos';
import { LedgerService } from '../ledger/ledger-service';

/** Overridable in tests; defaults to a full-page redirect (Stripe-hosted pages). */
export const BILLING_NAVIGATE = new InjectionToken<(url: string) => void>('BILLING_NAVIGATE', {
  providedIn: 'root',
  factory: () => (url: string) => location.assign(url),
});

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly navigate = inject(BILLING_NAVIGATE);

  /** Redirects to Stripe Checkout for a credits top-up (server adds Studio when needed). */
  async checkout(creditsUsd: number): Promise<void> {
    const body: CheckoutRequest = { creditsUsd };
    const { url } = await this.api.post<CheckoutResponse>('/billing/checkout', body);
    this.navigate(url);
  }

  /** Studio-only $5 checkout for lapsed accounts. */
  async reactivateStudio(): Promise<void> {
    const body: CheckoutRequest = { studioOnly: true };
    const { url } = await this.api.post<CheckoutResponse>('/billing/checkout', body);
    this.navigate(url);
  }

  /** Stripe Billing Portal: cancel, card, invoices. */
  async openPortal(): Promise<void> {
    const { url } = await this.api.post<CheckoutResponse>('/billing/portal', {});
    this.navigate(url);
  }

  /** Self-heal: credits any paid session missing from the ledger. Returns count. */
  async reconcile(): Promise<number> {
    const response = await this.api.post<ReconcileResponse>('/billing/reconcile', {});
    this.ledger.setBalance(response.balanceUsd);
    return response.credited;
  }
}
