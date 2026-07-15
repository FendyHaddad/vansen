import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, TitleCasePipe } from '@angular/common';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { LedgerService, LedgerEntry } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { BillingService } from '../../../core/billing/billing-service';
import { ApiError } from '../../../core/api/api-service';
import { BillingOverviewDto } from '../../../core/api/dtos';
import { SubscriptionStatus } from '../../../core/enums';
import {
  CREDIT_PACKS,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  familyById,
  packCredits,
} from '../../../core/catalog/model-families';
import { PlanChangeDialog } from '../../studio/plan-change-dialog/plan-change-dialog';
import { CancelFlowDialog } from '../cancel-flow-dialog/cancel-flow-dialog';

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

interface FamilyUsageRow {
  label: string;
  count: number;
  spendCredits: number;
  pct: number;
}

@Component({
  selector: 'app-billing-tab',
  templateUrl: './billing-tab.html',
  styleUrl: './billing-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, TitleCasePipe, HlmBadge, HlmButton, PlanChangeDialog, CancelFlowDialog],
})
export class BillingTab {
  private readonly ledger = inject(LedgerService);
  readonly profileStore = inject(ProfileStore);
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

  /** Next invoice + card on file, live from Stripe; null until it answers. */
  readonly overview = signal<BillingOverviewDto | null>(null);

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
    return plan === 'studio' || plan === 'pro' ? PLAN_PRICE_USD[plan] : null;
  });

  readonly planGrant = computed(() => {
    const plan = this.plan();
    return plan === 'studio' || plan === 'pro' ? PLAN_CREDITS[plan] : null;
  });

  /** Packs are priced by the buyer's tier (owner never buys). */
  readonly packRate = computed<'studio' | 'pro'>(() => (this.plan() === 'pro' ? 'pro' : 'studio'));

  /** Where a plan switch can go from here — drives the switch buttons. */
  readonly switchTarget = computed<'studio' | 'pro' | null>(() => {
    const plan = this.plan();
    if (plan === 'studio') return 'pro';
    if (plan === 'pro') return 'studio';
    return null;
  });

  /** Top models this month, by credits spent — the compact billing-side view;
   * the Usage tab keeps the full breakdown. */
  readonly topFamilies = computed<FamilyUsageRow[]>(() => {
    const now = new Date();
    const groups = new Map<string, { count: number; spend: number }>();
    for (const e of this.entries()) {
      if (e.amountCredits >= 0 || e.type === 'pack_expiry' || e.type === 'cycle_reset') continue;
      const d = new Date(e.createdAt);
      if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) continue;
      const label = this.familyName(e.familyId);
      const g = groups.get(label) ?? { count: 0, spend: 0 };
      g.count += 1;
      g.spend += Math.abs(e.amountCredits);
      groups.set(label, g);
    }
    const rows = [...groups.entries()]
      .map(([label, g]) => ({ label, count: g.count, spendCredits: g.spend }))
      .sort((a, b) => b.spendCredits - a.spendCredits)
      .slice(0, 5);
    const max = rows[0]?.spendCredits || 1;
    return rows.map((r) => ({ ...r, pct: Math.round((r.spendCredits / max) * 100) }));
  });

  constructor() {
    void this.ledger.loadEntries();
    if (!this.profileStore.loaded()) void this.profileStore.load();
    void this.loadOverview();
  }

  private async loadOverview(): Promise<void> {
    try {
      this.overview.set(await this.billing.overview());
    } catch {
      // The tab still works from the mirror; the Stripe extras just stay hidden.
    }
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

  async resume(): Promise<void> {
    await this.run(async () => {
      await this.billing.resumeSubscription();
      await this.profileStore.load();
      await this.loadOverview();
    });
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

  // ── Plan switch (same dialog the workspace uses) ───────────────────────────

  readonly planChange = signal<'studio' | 'pro' | null>(null);
  readonly planChangeBusy = signal(false);
  readonly planChangeError = signal('');

  readonly currentPlan = computed<'studio' | 'pro'>(() => (this.plan() === 'pro' ? 'pro' : 'studio'));

  openPlanChange(target: 'studio' | 'pro'): void {
    this.planChangeError.set('');
    this.planChange.set(target);
  }

  async confirmPlanChange(when: 'now' | 'period_end'): Promise<void> {
    const plan = this.planChange();
    if (!plan || this.planChangeBusy()) return;
    this.planChangeBusy.set(true);
    this.planChangeError.set('');
    try {
      await this.billing.changePlan(plan, when);
      await this.profileStore.load();
      await this.loadOverview();
      void this.ledger.loadEntries();
      this.planChange.set(null);
    } catch (e) {
      this.planChangeError.set(this.planChangeMessage(e));
    } finally {
      this.planChangeBusy.set(false);
    }
  }

  private planChangeMessage(e: unknown): string {
    if (e instanceof ApiError) {
      switch (e.code) {
        case 'subscription_ending':
          return 'Your subscription is set to end at renewal — resume it below first, then change plans.';
        case 'already_scheduled':
          return 'This change is already scheduled — it happens automatically at renewal.';
        case 'downgrade_at_period_end':
          return 'Downgrades take effect at your renewal date, not immediately.';
        case 'no_subscription':
          return 'No active subscription found — pick a plan first.';
        case 'same_plan':
          return 'You are already on this plan.';
      }
      return e.message;
    }
    return 'Could not change your plan — check your connection and try again.';
  }

  // ── Cancel flow ────────────────────────────────────────────────────────────

  readonly cancelOpen = signal(false);
  readonly cancelBusy = signal(false);
  readonly cancelError = signal('');
  readonly cancelDone = signal(false);

  openCancel(): void {
    this.cancelError.set('');
    this.cancelDone.set(false);
    this.cancelOpen.set(true);
  }

  async confirmCancel(reason: string): Promise<void> {
    if (this.cancelBusy()) return;
    this.cancelBusy.set(true);
    this.cancelError.set('');
    try {
      await this.billing.cancelSubscription(reason);
      await this.profileStore.load();
      await this.loadOverview();
      this.cancelDone.set(true);
    } catch (e) {
      this.cancelError.set(
        e instanceof ApiError ? e.message : 'Could not cancel — check your connection and try again.',
      );
    } finally {
      this.cancelBusy.set(false);
    }
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
    if (!id) return 'Other';
    if (id === 'upscaler' || id === 'magnific') return 'Upscale';
    return familyById(id)?.name ?? id;
  }
}
