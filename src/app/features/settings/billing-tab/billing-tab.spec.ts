import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingTab } from './billing-tab';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { BillingService } from '../../../core/billing/billing-service';
import { BillingOverviewDto, SubscriptionDto } from '../../../core/api/dtos';

/** An App Store subscriber is sent to Apple; the Stripe controls stay hidden. */
describe('BillingTab: who manages the plan', () => {
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString();

  function make(opts: {
    source: 'stripe' | 'app_store';
    status?: 'active' | 'canceled';
    overview?: BillingOverviewDto | null;
  }) {
    const sub = {
      plan: 'studio',
      status: opts.status ?? 'active',
      currentPeriodEnd: future,
      pendingPlan: null,
      pendingAt: null,
      entitled: true,
    } as SubscriptionDto;
    TestBed.configureTestingModule({
      imports: [BillingTab],
      providers: [
        {
          provide: LedgerService,
          useValue: {
            planCredits: signal(0),
            packCredits: signal(0),
            totalCredits: signal(0),
            entries: signal([]),
            loadEntries: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: ProfileStore,
          useValue: {
            plan: signal('studio'),
            isOwner: signal(false),
            loaded: signal(true),
            subscription: signal(sub),
            daysUntilPurge: signal(null),
            managedInAppStore: signal(opts.source === 'app_store'),
            load: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: BillingService,
          useValue: { overview: vi.fn(() => Promise.resolve(opts.overview ?? null)) },
        },
      ],
    });
    const fixture = TestBed.createComponent(BillingTab);
    fixture.detectChanges();
    return fixture;
  }

  function render(opts: Parameters<typeof make>[0]): HTMLElement {
    return make(opts).nativeElement as HTMLElement;
  }

  /** Waits for the overview (the live Stripe read) to land. */
  async function settled(opts: Parameters<typeof make>[0]): Promise<HTMLElement> {
    const fixture = make(opts);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const LIVE_STRIPE: BillingOverviewDto = {
    cancelAtPeriodEnd: false,
    upcoming: { amountUsd: 15, date: future },
    paymentMethod: { brand: 'visa', last4: '4242' },
    stripeSubscription: true,
  };

  beforeEach(() => TestBed.resetTestingModule());

  it('an App Store plan shows "Managed in the App Store" with the Apple link', () => {
    const el = render({ source: 'app_store' });
    expect(el.textContent).toContain('Managed in the App Store');
    const link = el.querySelector<HTMLAnchorElement>('a.app-store-link');
    expect(link?.href).toBe('https://apps.apple.com/account/subscriptions');
  });

  it('an App Store plan hides the Stripe cancel, portal, switch and card controls', () => {
    const text = render({ source: 'app_store' }).textContent ?? '';
    expect(text).not.toContain('Cancel subscription');
    expect(text).not.toContain('Invoices & card');
    expect(text).not.toContain('Upgrade to Pro');
    expect(text).not.toContain('Change card');
    expect(text).not.toContain('Next invoice');
  });

  it('an App Store plan set to end offers no Stripe resume', () => {
    const text = render({ source: 'app_store', status: 'canceled' }).textContent ?? '';
    expect(text).not.toContain('Resume subscription');
    expect(text).toContain('Managed in the App Store');
  });

  it('a Stripe plan keeps the Stripe controls', () => {
    const text = render({ source: 'stripe' }).textContent ?? '';
    expect(text).toContain('Cancel subscription');
    expect(text).toContain('Invoices & card');
    expect(text).not.toContain('Managed in the App Store');
  });

  it('an App Store source with a live Stripe subscription keeps the Stripe controls (C1)', async () => {
    const el = await settled({ source: 'app_store', overview: LIVE_STRIPE });
    const text = el.textContent ?? '';
    expect(text).toContain('Cancel subscription');
    expect(text).toContain('Invoices & card');
    expect(text).toContain('Next invoice');
  });

  it('two subscriptions show both the App Store link and a plain note', async () => {
    const el = await settled({ source: 'app_store', overview: LIVE_STRIPE });
    expect(el.querySelector('a.app-store-link')).not.toBeNull();
    expect(el.querySelector('.two-subs-note')?.textContent).toContain('two subscriptions');
    expect(el.textContent).not.toContain('Managed in the App Store');
  });

  it('two subscriptions: a Stripe side set to end offers resume, not cancel', async () => {
    const el = await settled({
      source: 'app_store',
      overview: { ...LIVE_STRIPE, cancelAtPeriodEnd: true },
    });
    const text = el.textContent ?? '';
    expect(text).toContain('Resume subscription');
    expect(text).not.toContain('Cancel subscription');
  });

  it('an App Store source with nothing live in Stripe stays App Store only', async () => {
    const el = await settled({
      source: 'app_store',
      overview: { ...LIVE_STRIPE, upcoming: null, paymentMethod: null, stripeSubscription: false },
    });
    const text = el.textContent ?? '';
    expect(text).toContain('Managed in the App Store');
    expect(text).not.toContain('Cancel subscription');
    expect(el.querySelector('.two-subs-note')).toBeNull();
  });
});
