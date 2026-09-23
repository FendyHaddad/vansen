import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api/api-service';
import { BillingService } from '../../core/billing/billing-service';
import { CheckoutIntent } from '../../core/billing/checkout-intent';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { WorkspaceNotices } from './workspace-notices';

/**
 * Subscription / plan-change / checkout-redirect handling for the workspace
 * page, moved out of WorkspacePage verbatim. Component-scoped (see the
 * component's `providers`) so a fresh instance is created with each page.
 */
@Injectable()
export class WorkspaceBillingActions {
  private readonly billing = inject(BillingService);
  private readonly checkoutIntent = inject(CheckoutIntent);
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly notices = inject(WorkspaceNotices);

  /** True while a Stripe redirect is in flight — the CTA must show progress and
   * refuse repeat clicks, since the round trip is slow enough to look frozen. */
  readonly checkoutBusy = signal(false);

  /** Add-on packs popup, opened from the topbar next to the balance it feeds. */
  readonly packsOpen = signal(false);

  /** Target plan of the open confirm dialog, or null when closed. */
  readonly planChange = signal<'studio' | 'pro' | null>(null);
  readonly planChangeBusy = signal(false);
  /** Rejection shown inside the dialog — the notice banner sits behind the
   * backdrop, where an error reads as "the button did nothing". */
  readonly planChangeError = signal('');

  /** Plan the switch is measured against — the dialog needs both ends. */
  readonly currentPlan = computed<'studio' | 'pro'>(() =>
    this.profileStore.subscription()?.plan === 'pro' ? 'pro' : 'studio',
  );

  /**
   * Resume a plan picked on the pricing page before signing in. Runs after
   * refresh() so studioActive() is known: someone who subscribed in another tab
   * must not be sent to checkout again. Returns true when checkout is opening,
   * so the caller can skip the tour rather than start it under a redirect.
   */
  resumeCheckoutIntent(): boolean {
    const plan = this.checkoutIntent.take();
    if (!plan || this.profileStore.studioActive()) return false;
    void this.subscribeTo(plan);
    return true;
  }

  /** Stripe redirects back with ?checkout=success|canceled; webhook may lag a second. */
  handleCheckoutReturn(): void {
    const result = this.route.snapshot.queryParamMap.get('checkout');
    if (!result) return;
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
    if (result === 'canceled') {
      this.notices.notice.set('Checkout canceled — nothing was charged.');
      return;
    }
    if (result !== 'success') return;
    const before = this.ledger.totalCredits();
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      await this.profileStore.load();
      if (this.ledger.totalCredits() !== before) {
        clearInterval(poll);
        this.notices.notice.set(`Payment received — ${this.ledger.totalCredits().toLocaleString()} credits.`);
      } else if (attempts >= 6) {
        clearInterval(poll);
        this.notices.notice.set(
          'Payment received — credits are on the way. If they don’t appear, use “Didn’t receive your credits?” in Settings → Subscription.',
        );
      }
    }, 1000);
  }

  /** Grace banner / teaser CTA — start a subscription on the plan the visitor picked. */
  async subscribeTo(plan: 'studio' | 'pro'): Promise<void> {
    if (this.checkoutBusy()) return;
    this.checkoutBusy.set(true);
    try {
      await this.billing.subscribe(plan);
    } catch (e) {
      // Only clear on failure: success navigates away, and flipping the button
      // back to idle mid-redirect invites a second click and a second session.
      this.checkoutBusy.set(false);
      this.notices.showError(e, 'Could not start checkout');
    }
  }

  /**
   * Studio → Pro. Confirm first: plan credits do not carry across a switch, so
   * this must never fire straight from a button press.
   */
  upgradePlan(): void {
    this.planChangeError.set('');
    this.planChange.set('pro');
  }

  /** Pro → Studio, same dialog — the server holds it to period-end anyway. */
  downgradePlan(): void {
    this.planChangeError.set('');
    this.planChange.set('studio');
  }

  async confirmPlanChange(when: 'now' | 'period_end'): Promise<void> {
    const plan = this.planChange();
    if (!plan || this.planChangeBusy()) return;
    this.planChangeBusy.set(true);
    this.planChangeError.set('');
    try {
      const before = this.ledger.totalCredits();
      const { effectiveAt } = await this.billing.changePlan(plan, when);
      await this.profileStore.load();
      const label = plan === 'pro' ? 'Pro' : 'Studio';
      this.notices.notice.set(
        effectiveAt
          ? `${label} starts ${new Date(effectiveAt).toLocaleDateString()} — you keep your current plan until then.`
          : `You're on ${label} now — enjoy your fresh credits.`,
      );
      this.planChange.set(null);
      // The plan mirror updates synchronously, but the fresh grant lands via the
      // invoice.paid webhook a beat later — poll so the credit chip catches up
      // without a manual refresh.
      if (!effectiveAt) this.pollCreditsUntilChanged(before);
    } catch (e) {
      this.planChangeError.set(this.planChangeMessage(e));
    } finally {
      this.planChangeBusy.set(false);
    }
  }

  private pollCreditsUntilChanged(before: number): void {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      await this.profileStore.load();
      if (this.ledger.totalCredits() !== before || attempts >= 8) clearInterval(poll);
    }, 1000);
  }

  private planChangeMessage(e: unknown): string {
    if (e instanceof ApiError) {
      switch (e.code) {
        case 'subscription_ending':
          return 'Your subscription is set to end at renewal — resume it from Settings → Subscription first, then change plans.';
        case 'already_scheduled':
          return 'This change is already scheduled — it happens automatically at renewal.';
        case 'downgrade_at_period_end':
          return 'Downgrades take effect at your renewal date, not immediately.';
        case 'no_subscription':
          return 'No active subscription found — pick a plan from the pricing page first.';
        case 'same_plan':
          return 'You are already on this plan.';
      }
      return e.message;
    }
    return 'Could not change your plan — check your connection and try again.';
  }
}
