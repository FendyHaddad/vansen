import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService } from '../ledger/ledger-service';
import { PreferencesService } from '../preferences/preferences-service';
import { ProfileResponse, SubscriptionDto } from '../api/dtos';
import { ProfileStore } from './profile-store';

function response(subscription: SubscriptionDto | null): ProfileResponse {
  return {
    profile: {
      id: 'u1',
      email: 'u@example.com',
      displayName: 'U',
      prefs: {},
      createdAt: '2026-01-01T00:00:00Z',
    },
    credits: { plan: 0, pack: 0 },
    subscription,
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
      response({ plan: 'studio', status: 'expired', currentPeriodEnd: past }),
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
      response({ plan: 'studio', status: 'canceled', currentPeriodEnd: past }),
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
});
