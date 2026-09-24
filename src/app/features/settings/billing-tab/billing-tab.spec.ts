import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingTab } from './billing-tab';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { BillingService } from '../../../core/billing/billing-service';
import { SubscriptionDto } from '../../../core/api/dtos';

/** An App Store subscriber is sent to Apple; the Stripe controls stay hidden. */
describe('BillingTab: who manages the plan', () => {
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString();

  function make(opts: { source: 'stripe' | 'app_store'; status?: 'active' | 'canceled' }) {
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
          useValue: { overview: vi.fn(() => Promise.resolve(null)) },
        },
      ],
    });
    const fixture = TestBed.createComponent(BillingTab);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('an App Store plan shows "Managed in the App Store" with the Apple link', () => {
    const el = make({ source: 'app_store' });
    expect(el.textContent).toContain('Managed in the App Store');
    const link = el.querySelector<HTMLAnchorElement>('a.app-store-link');
    expect(link?.href).toBe('https://apps.apple.com/account/subscriptions');
  });

  it('an App Store plan hides the Stripe cancel, portal, switch and card controls', () => {
    const text = make({ source: 'app_store' }).textContent ?? '';
    expect(text).not.toContain('Cancel subscription');
    expect(text).not.toContain('Invoices & card');
    expect(text).not.toContain('Upgrade to Pro');
    expect(text).not.toContain('Change card');
    expect(text).not.toContain('Next invoice');
  });

  it('an App Store plan set to end offers no Stripe resume', () => {
    const text = make({ source: 'app_store', status: 'canceled' }).textContent ?? '';
    expect(text).not.toContain('Resume subscription');
    expect(text).toContain('Managed in the App Store');
  });

  it('a Stripe plan keeps the Stripe controls', () => {
    const text = make({ source: 'stripe' }).textContent ?? '';
    expect(text).toContain('Cancel subscription');
    expect(text).toContain('Invoices & card');
    expect(text).not.toContain('Managed in the App Store');
  });
});
