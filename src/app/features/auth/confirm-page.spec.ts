import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmPage } from './confirm-page';
import { AuthService } from '../../core/auth/auth-service';

function make(auth: Partial<AuthService>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: auth }, provideRouter([])],
  });
  const fixture = TestBed.createComponent(ConfirmPage);
  fixture.detectChanges();
  return fixture;
}

/**
 * Resending a confirmation discloses no more than asking for a reset does:
 * whether an address has an unconfirmed account is the same private fact.
 */
describe('ConfirmPage', () => {
  it('shows the generic confirmation and prevents duplicate submission', async () => {
    let finish!: () => void;
    const auth = {
      resendConfirmation: vi.fn(
        () => new Promise<void>((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const fixture = make(auth as unknown as AuthService);
    const page = fixture.componentInstance;

    page.email.set('person@example.com');
    const pending = page.submit();
    expect(page.pending()).toBe(true);
    await page.submit();
    expect(auth.resendConfirmation).toHaveBeenCalledTimes(1);

    finish();
    await pending;
    fixture.detectChanges();
    expect(page.sent()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('If an account exists');
  });

  it('answers an unknown address identically', async () => {
    const auth = { resendConfirmation: vi.fn(() => Promise.resolve()) };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.email.set('nobody@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('If an account exists');
    expect(fixture.nativeElement.textContent).not.toContain('not found');
  });

  it('refuses an empty address without calling the service', async () => {
    const auth = { resendConfirmation: vi.fn(() => Promise.resolve()) };
    const fixture = make(auth as unknown as AuthService);
    await fixture.componentInstance.submit();
    expect(auth.resendConfirmation).not.toHaveBeenCalled();
  });

  it('clears pending when the request fails', async () => {
    const auth = { resendConfirmation: vi.fn(() => Promise.reject(new Error('offline'))) };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    await fixture.componentInstance.submit();
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.componentInstance.error()).toBeTruthy();
  });

  it('labels its input', () => {
    const auth = { resendConfirmation: vi.fn(() => Promise.resolve()) };
    const fixture = make(auth as unknown as AuthService);
    const input = fixture.nativeElement.querySelector('input[type="email"]') as HTMLInputElement;
    expect(fixture.nativeElement.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
  });
});
