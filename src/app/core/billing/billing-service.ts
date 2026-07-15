import { Injectable, InjectionToken, inject } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  BillingOverviewDto,
  CancelStateResponse,
  CancelSubscriptionRequest,
  ChangePlanRequest,
  ChangePlanResponse,
  CheckoutResponse,
  PackRequest,
  ReconcileResponse,
  SubscribeRequest,
} from '../api/dtos';
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

  /** Redirects to Stripe Checkout for a Studio or Pro subscription. */
  async subscribe(plan: 'studio' | 'pro'): Promise<void> {
    const body: SubscribeRequest = { plan };
    const { url } = await this.api.post<CheckoutResponse>('/billing/subscribe', body);
    this.navigate(url);
  }

  /** Redirects to Stripe Checkout for an add-on credit pack (subscribers only). */
  async buyPack(usd: number): Promise<void> {
    const body: PackRequest = { usd };
    const { url } = await this.api.post<CheckoutResponse>('/billing/pack', body);
    this.navigate(url);
  }

  /**
   * Switch between Studio and Pro on the existing subscription. No redirect:
   * Stripe already has the card, so the change applies in place and the caller
   * just reloads the profile.
   */
  async changePlan(plan: 'studio' | 'pro', when: 'now' | 'period_end'): Promise<ChangePlanResponse> {
    const body: ChangePlanRequest = { plan, when };
    return await this.api.post<ChangePlanResponse>('/billing/change-plan', body);
  }

  /** Next invoice, card on file, cancellation state — straight from Stripe. */
  async overview(): Promise<BillingOverviewDto> {
    return await this.api.get<BillingOverviewDto>('/billing/overview');
  }

  /** Cancel at period end (never immediate) with the survey reason attached. */
  async cancelSubscription(reason: string): Promise<void> {
    const body: CancelSubscriptionRequest = { reason };
    await this.api.post<CancelStateResponse>('/billing/cancel', body);
  }

  /** Undo a pending cancellation — billing continues untouched. */
  async resumeSubscription(): Promise<void> {
    await this.api.post<CancelStateResponse>('/billing/resume', {});
  }

  /** Stripe Billing Portal: card, invoices. */
  async openPortal(): Promise<void> {
    const { url } = await this.api.post<CheckoutResponse>('/billing/portal', {});
    this.navigate(url);
  }

  /** Self-heal: credits any paid pack session missing from the ledger. Returns count. */
  async reconcile(): Promise<number> {
    const response = await this.api.post<ReconcileResponse>('/billing/reconcile', {});
    this.ledger.setCredits(response.credits);
    return response.credited;
  }
}
