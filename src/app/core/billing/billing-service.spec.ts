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

  it('checkout posts the amount and redirects to the session url', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });
    await make().checkout(20);
    expect(apiMock.post).toHaveBeenCalledWith('/billing/checkout', { creditsUsd: 20 });
    expect(navMock).toHaveBeenCalledWith('https://checkout.stripe.com/x');
  });

  it('reactivateStudio posts studioOnly', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://checkout.stripe.com/y' });
    await make().reactivateStudio();
    expect(apiMock.post).toHaveBeenCalledWith('/billing/checkout', { studioOnly: true });
    expect(navMock).toHaveBeenCalledWith('https://checkout.stripe.com/y');
  });

  it('openPortal redirects to the portal url', async () => {
    apiMock.post.mockResolvedValue({ url: 'https://billing.stripe.com/p' });
    await make().openPortal();
    expect(apiMock.post).toHaveBeenCalledWith('/billing/portal', {});
    expect(navMock).toHaveBeenCalledWith('https://billing.stripe.com/p');
  });

  it('reconcile returns the credited count', async () => {
    apiMock.post.mockResolvedValue({ credited: 2, balanceUsd: 30 });
    await expect(make().reconcile()).resolves.toBe(2);
    expect(apiMock.post).toHaveBeenCalledWith('/billing/reconcile', {});
  });
});
