import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../core/api/api-service';
import { BillingService } from '../../../core/billing/billing-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { CreditPacksDialog } from './credit-packs-dialog';

describe('CreditPacksDialog', () => {
  let fixture: ComponentFixture<CreditPacksDialog>;
  const buyPack = vi.fn<(usd: number) => Promise<void>>();
  const subscription = signal<{ plan: string } | null>(null);

  function make(plan: 'studio' | 'pro') {
    subscription.set({ plan });
    buyPack.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [CreditPacksDialog],
      providers: [
        { provide: BillingService, useValue: { buyPack } },
        { provide: ProfileStore, useValue: { subscription } },
      ],
    });
    fixture = TestBed.createComponent(CreditPacksDialog);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('prices packs at the Studio rate for Studio subscribers', () => {
    const dialog = make('studio');
    expect(dialog.creditsFor(10)).toBe(1000);
    expect(dialog.creditsFor(25)).toBe(2625);
  });

  it('prices packs 25% richer for Pro subscribers', () => {
    const dialog = make('pro');
    expect(dialog.creditsFor(10)).toBe(1250);
  });

  it('starts checkout once — repeat clicks while busy are ignored', async () => {
    const dialog = make('studio');
    buyPack.mockReturnValue(new Promise(() => {})); // redirect never resolves in tests
    void dialog.buy(10);
    void dialog.buy(10);
    void dialog.buy(25);
    expect(buyPack).toHaveBeenCalledTimes(1);
    expect(buyPack).toHaveBeenCalledWith(10);
  });

  it('cannot be dismissed while checkout is opening', () => {
    const dialog = make('studio');
    buyPack.mockReturnValue(new Promise(() => {}));
    void dialog.buy(10);
    let dismissed = 0;
    dialog.dismissed.subscribe(() => (dismissed += 1));
    dialog.close();
    expect(dismissed).toBe(0);
  });

  it('shows the server rejection inside the dialog and unlocks the packs', async () => {
    const dialog = make('studio');
    buyPack.mockRejectedValue(new ApiError('subscription_required', 'Packs are for subscribers', 403));
    await dialog.buy(10);
    fixture.detectChanges();
    expect(dialog.busy()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Packs are for subscribers');
  });
});
