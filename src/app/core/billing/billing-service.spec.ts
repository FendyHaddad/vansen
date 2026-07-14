import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { BILLING_NAVIGATE, BillingService } from './billing-service';

describe('BillingService', () => {
  const apiMock = { post: vi.fn() };
  const navMock = vi.fn();

  function make(): BillingService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: BILLING_NAVIGATE, useValue: navMock },
      ],
    });
    return TestBed.inject(BillingService);
  }

  beforeEach(() => {
    apiMock.post.mockReset();
    navMock.mockReset();
  });

  it('subscribes via /billing/subscribe and redirects to the session url', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });
    await make().subscribe('pro');
    expect(apiMock.post).toHaveBeenCalledWith('/billing/subscribe', { plan: 'pro' });
    expect(navMock).toHaveBeenCalledWith('https://checkout.stripe.com/x');
  });

  it('buys packs via /billing/pack', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://checkout.stripe.com/y' });
    await make().buyPack(50);
    expect(apiMock.post).toHaveBeenCalledWith('/billing/pack', { usd: 50 });
    expect(navMock).toHaveBeenCalledWith('https://checkout.stripe.com/y');
  });

  it('openPortal redirects to the portal url', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://billing.stripe.com/p' });
    await make().openPortal();
    expect(apiMock.post).toHaveBeenCalledWith('/billing/portal', {});
    expect(navMock).toHaveBeenCalledWith('https://billing.stripe.com/p');
  });

  it('reconcile returns the credited count', async () => {
    apiMock.post.mockResolvedValue({ credited: 2, credits: { plan: 1500, pack: 1000 } });
    await expect(make().reconcile()).resolves.toBe(2);
    expect(apiMock.post).toHaveBeenCalledWith('/billing/reconcile', {});
  });
});
