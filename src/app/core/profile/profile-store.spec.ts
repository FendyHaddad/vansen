import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService } from '../ledger/ledger-service';
import { PreferencesService } from '../preferences/preferences-service';
import { ProfileResponse, SubscriptionDto } from '../api/dtos';
import { ProfileStore } from './profile-store';

/** No scheduled change is the norm; the server's entitlement defaults to true. */
type SubFixture = Omit<SubscriptionDto, 'pendingPlan' | 'pendingAt' | 'entitled'> &
  Partial<Pick<SubscriptionDto, 'pendingPlan' | 'pendingAt' | 'entitled'>>;

function response(subscription: SubFixture | null): ProfileResponse {
  return {
    profile: {
      id: 'u1',
      email: 'u@example.com',
      displayName: 'U',
      prefs: {},
      createdAt: '2026-01-01T00:00:00Z',
      ageConfirmed: true,
    },
    credits: { plan: 0, pack: 0 },
    subscription: subscription
      ? { pendingPlan: null, pendingAt: null, entitled: true, ...subscription }
      : null,
  };
}

describe('ProfileStore plan computeds', () => {
  const apiMock = { get: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const prefsMock = { applyServerPrefs: vi.fn() };

  function make(): ProfileStore {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: PreferencesService, useValue: prefsMock },
      ],
    });
    return TestBed.inject(ProfileStore);
  }

  beforeEach(() => {
    apiMock.get.mockReset();
    ledgerMock.setCredits.mockReset();
    prefsMock.applyServerPrefs.mockReset();
  });

  it('plan() resolves the active plan and nulls expired ones', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'pro', status: 'active', currentPeriodEnd: future }),
    );
    const store = make();
    await store.load();
    expect(store.plan()).toBe('pro');
  });

  it('plan() is null with no subscription or an expired one', async () => {
    apiMock.get.mockResolvedValue(response(null));
    const store = make();
    await store.load();
    expect(store.plan()).toBeNull();

    const past = new Date(Date.now() - 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'expired', currentPeriodEnd: past, entitled: false }),
    );
    await store.load();
    expect(store.plan()).toBeNull();
  });

  it('plan() keeps a canceled subscription until its period end', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'canceled', currentPeriodEnd: future }),
    );
    const store = make();
    await store.load();
    expect(store.plan()).toBe('studio');

    const past = new Date(Date.now() - 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'canceled', currentPeriodEnd: past, entitled: false }),
    );
    await store.load();
    expect(store.plan()).toBeNull();
  });

  it('owner subscription: isOwner, proActive, studioActive all true', async () => {
    apiMock.get.mockResolvedValue(
      response({ plan: 'owner', status: 'active', currentPeriodEnd: null }),
    );
    const store = make();
    await store.load();
    expect(store.isOwner()).toBe(true);
    expect(store.proActive()).toBe(true);
    expect(store.studioActive()).toBe(true);
  });

  it('pro subscription with a future period end: proActive true, isOwner false', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'pro', status: 'active', currentPeriodEnd: future }),
    );
    const store = make();
    await store.load();
    expect(store.proActive()).toBe(true);
    expect(store.isOwner()).toBe(false);
  });

  it('studio subscription: proActive and isOwner false, studioActive true', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'active', currentPeriodEnd: future }),
    );
    const store = make();
    await store.load();
    expect(store.proActive()).toBe(false);
    expect(store.isOwner()).toBe(false);
    expect(store.studioActive()).toBe(true);
  });

  it('no subscription: everything false', async () => {
    apiMock.get.mockResolvedValue(response(null));
    const store = make();
    await store.load();
    expect(store.proActive()).toBe(false);
    expect(store.isOwner()).toBe(false);
    expect(store.studioActive()).toBe(false);
  });

  it("entitled is the server's call, not a status check", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'pro', status: 'canceled', currentPeriodEnd: past, entitled: true }),
    );
    const store = make();
    await store.load();
    expect(store.entitled()).toBe(true);
    expect(store.plan()).toBe('pro');
    expect(store.proActive()).toBe(true);

    apiMock.get.mockResolvedValue(
      response({ plan: 'pro', status: 'active', currentPeriodEnd: null, entitled: false }),
    );
    await store.load();
    expect(store.entitled()).toBe(false);
    expect(store.plan()).toBeNull();
    expect(store.studioActive()).toBe(false);
    expect(store.proActive()).toBe(false);
  });

  it('a cached profile from before entitled existed reads as not entitled', async () => {
    const legacy = {
      plan: 'studio',
      status: 'active',
      currentPeriodEnd: null,
      pendingPlan: null,
      pendingAt: null,
    } as unknown as SubscriptionDto;
    apiMock.get.mockResolvedValue({ ...response(null), subscription: legacy });
    const store = make();
    await store.load();
    expect(store.entitled()).toBe(false);
    expect(store.studioActive()).toBe(false);
  });
});

/**
 * The countdown runs BEFORE the library goes. The old `graceDaysLeft` counted
 * 30 days after the period had already ended — a window retention policy D2
 * removed, and one the customer could no longer act inside anyway.
 */
describe('ProfileStore daysUntilPurge', () => {
  const apiMock = { get: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const prefsMock = { applyServerPrefs: vi.fn() };

  function make(): ProfileStore {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: PreferencesService, useValue: prefsMock },
      ],
    });
    return TestBed.inject(ProfileStore);
  }

  beforeEach(() => {
    apiMock.get.mockReset();
    ledgerMock.setCredits.mockReset();
    prefsMock.applyServerPrefs.mockReset();
  });

  it('counts the days a cancelled plan has left', async () => {
    const end = new Date(Date.now() + 3 * 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'canceled', currentPeriodEnd: end }),
    );
    const store = make();
    await store.load();
    expect(store.daysUntilPurge()).toBe(3);
  });

  it('says nothing once the period has ended — there is no grace after it', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'studio', status: 'expired', currentPeriodEnd: past }),
    );
    const store = make();
    await store.load();
    expect(store.daysUntilPurge()).toBeNull();
  });

  it('is silent while the subscription is simply renewing', async () => {
    const end = new Date(Date.now() + 10 * 86_400_000).toISOString();
    apiMock.get.mockResolvedValue(
      response({ plan: 'pro', status: 'active', currentPeriodEnd: end }),
    );
    const store = make();
    await store.load();
    expect(store.daysUntilPurge()).toBeNull();
  });
});
