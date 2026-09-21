import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetPage } from './reset-page';
import { AuthService } from '../../core/auth/auth-service';

function make(auth: Partial<AuthService>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: auth }, provideRouter([])],
  });
  const fixture = TestBed.createComponent(ResetPage);
  fixture.detectChanges();
  return fixture;
}

const ok = () => ({
  completePasswordReset: vi.fn(() => Promise.resolve()),
  cancelPasswordReset: vi.fn(),
  recoveryPending: () => true,
});

/**
 * The reset form acts on a verified recovery or on nothing.
 *
 * The service is what enforces that; these tests are about the page never
 * implying otherwise — never routing to the app on a failure, never leaving a
 * customer stranded on an expired link with no way forward.
 */
describe('ResetPage', () => {
  let router: Router;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a short password without calling the service', async () => {
    const auth = ok();
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.password.set('short');
    await fixture.componentInstance.submit();
    expect(auth.completePasswordReset).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toMatch(/8 characters/);
  });

  it('navigates to the app only after the update succeeds', async () => {
    const auth = ok();
    const fixture = make(auth as unknown as AuthService);
    router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.componentInstance.password.set('a-good-password');
    await fixture.componentInstance.submit();
    expect(auth.completePasswordReset).toHaveBeenCalledWith('a-good-password');
    expect(nav).toHaveBeenCalledWith(['/app']);
  });

  it('stays put when the update fails, and stays retryable', async () => {
    const auth = {
      ...ok(),
      completePasswordReset: vi.fn(() => Promise.reject(new Error('The password could not be updated. Please try again.'))),
    };
    const fixture = make(auth as unknown as AuthService);
    router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.componentInstance.password.set('a-good-password');
    await fixture.componentInstance.submit();
    expect(nav).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toContain('could not be updated');
    expect(fixture.componentInstance.pending()).toBe(false);
  });

  it('shows the expired-link message and a way to get a new one', async () => {
    const auth = {
      ...ok(),
      completePasswordReset: vi.fn(() =>
        Promise.reject(new Error('That reset link has expired. Request a new one.')),
      ),
    };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.password.set('a-good-password');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('expired');
    const link = fixture.nativeElement.querySelector('a[href="/recover"]');
    expect(link).toBeTruthy();
  });

  it('tells someone who arrived without a link what to do', () => {
    // Otherwise the form looks usable, they type a password, and it fails.
    const fixture = make({ ...ok(), recoveryPending: () => false } as unknown as AuthService);
    expect(fixture.nativeElement.textContent).toMatch(/reset link/i);
    expect(fixture.nativeElement.querySelector('button[type="submit"]')).toBeNull();
  });

  it('ends the recovery when the page goes away', () => {
    // Walking away from an open reset form must not leave it usable.
    const auth = ok();
    const fixture = make(auth as unknown as AuthService);
    fixture.destroy();
    expect(auth.cancelPasswordReset).toHaveBeenCalled();
  });

  it('does not submit twice', async () => {
    let finish!: () => void;
    const auth = {
      ...ok(),
      completePasswordReset: vi.fn(
        () => new Promise<void>((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.password.set('a-good-password');
    const first = fixture.componentInstance.submit();
    await fixture.componentInstance.submit();
    expect(auth.completePasswordReset).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('labels its password input and disables the button while busy', () => {
    const auth = ok();
    const fixture = make(auth as unknown as AuthService);
    const input = fixture.nativeElement.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(fixture.nativeElement.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
    fixture.componentInstance.password.set('a-good-password');
    void fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(true);
  });

  it('announces its error politely', async () => {
    const fixture = make(ok() as unknown as AuthService);
    fixture.componentInstance.password.set('short');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    const live = fixture.nativeElement.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/8 characters/);
  });
});

/**
 * The code must not survive in the address bar.
 *
 * The Supabase client consumes it before this page renders, but it stays in
 * the URL — and therefore in history, in a bookmark and in the Referer of the
 * next request. Anyone who recovers it can open the recovery again.
 */
describe('ResetPage scrubs the recovery code from the URL', () => {
  const at = (href: string) => {
    history.replaceState(null, '', href);
    make(ok() as unknown as AuthService);
    return location.href;
  };

  it('removes a PKCE code from the query string', () => {
    expect(at('/reset?code=super-secret-code')).not.toContain('super-secret-code');
    expect(location.pathname).toBe('/reset');
  });

  it('removes an implicit-flow token from the fragment', () => {
    expect(at('/reset#access_token=abc123&type=recovery')).not.toContain('abc123');
  });

  it('leaves an ordinary /reset URL alone', () => {
    expect(at('/reset')).toContain('/reset');
  });

  it('keeps any non-sensitive parameter', () => {
    const href = at('/reset?code=secret&from=email');
    expect(href).toContain('from=email');
    expect(href).not.toContain('secret');
  });
});
