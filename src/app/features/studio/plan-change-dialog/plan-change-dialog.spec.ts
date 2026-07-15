import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlanChangeDialog } from './plan-change-dialog';

describe('PlanChangeDialog', () => {
  let fixture: ComponentFixture<PlanChangeDialog>;

  function make(
    current: 'studio' | 'pro',
    target: 'studio' | 'pro',
    planCredits = 0,
    pendingPlan: 'studio' | 'pro' | null = null,
  ) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [PlanChangeDialog] });
    fixture = TestBed.createComponent(PlanChangeDialog);
    fixture.componentRef.setInput('current', current);
    fixture.componentRef.setInput('target', target);
    fixture.componentRef.setInput('planCredits', planCredits);
    fixture.componentRef.setInput('pendingPlan', pendingPlan);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to the option that moves no money', () => {
    expect(make('studio', 'pro').when()).toBe('period_end');
  });

  it('offers an immediate start when upgrading', () => {
    expect(make('studio', 'pro').canSwitchNow()).toBe(true);
  });

  it('refuses an immediate downgrade — it would delete paid-for credits', () => {
    const dialog = make('pro', 'studio', 3000);
    expect(dialog.canSwitchNow()).toBe(false);
    dialog.choose('now');
    expect(dialog.when()).toBe('period_end');
  });

  it('warns about the exact credits an immediate switch replaces', () => {
    const dialog = make('studio', 'pro', 1200);
    dialog.choose('now');
    expect(dialog.creditsLost()).toBe(1200);
  });

  it('warns about nothing when the change waits for renewal', () => {
    expect(make('studio', 'pro', 1200).creditsLost()).toBe(0);
  });

  it('jumps to "start now" when the same change is already booked for renewal', () => {
    const dialog = make('studio', 'pro', 0, 'pro');
    expect(dialog.alreadyScheduled()).toBe(true);
    expect(dialog.when()).toBe('now');
  });

  it('refuses to book the same renewal change twice', () => {
    const dialog = make('studio', 'pro', 0, 'pro');
    dialog.choose('period_end');
    expect(dialog.when()).toBe('now');
  });

  it('confirm is inert when renewal is the pick and the change is already booked', () => {
    const dialog = make('pro', 'studio', 0, 'studio');
    let emitted = 0;
    dialog.confirmed.subscribe(() => (emitted += 1));
    expect(dialog.when()).toBe('period_end');
    dialog.confirm();
    expect(emitted).toBe(0);
  });

  it('a booked downgrade leaves nothing to confirm — dialog is informational', () => {
    const dialog = make('pro', 'studio', 0, 'studio');
    expect(dialog.scheduledOnly()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('already booked');
    expect(fixture.nativeElement.textContent).toContain('Close');
  });

  it('shows the server rejection inside the dialog, not behind it', () => {
    make('studio', 'pro');
    fixture.componentRef.setInput('error', 'Resume your subscription first');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Resume your subscription first');
  });

  it('cannot be dismissed or re-confirmed while the request is in flight', () => {
    const dialog = make('studio', 'pro');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    let dismissed = 0;
    let confirmed = 0;
    dialog.dismissed.subscribe(() => (dismissed += 1));
    dialog.confirmed.subscribe(() => (confirmed += 1));
    dialog.close();
    dialog.confirm();
    expect(dismissed).toBe(0);
    expect(confirmed).toBe(0);
  });

  it('spells out the credit reset only for an immediate switch', () => {
    const dialog = make('studio', 'pro', 1200);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('1,200');
    dialog.choose('now');
    fixture.detectChanges();
    // Soft tone, but both numbers stay on screen: what they gain and what closes out.
    expect(fixture.nativeElement.textContent).toContain('1,200');
    expect(fixture.nativeElement.textContent).toContain('3,750');
  });
});
