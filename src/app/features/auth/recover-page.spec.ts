import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoverPage } from './recover-page';
import { AuthService } from '../../core/auth/auth-service';

function make(auth: Partial<AuthService>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: auth }, provideRouter([])],
  });
  const fixture = TestBed.createComponent(RecoverPage);
  fixture.detectChanges();
  return fixture;
}

/**
 * Anti-enumeration: every answer this form gives is the same answer.
 *
 * "No account with that email" turns the form into a free list of which
 * addresses have accounts, which is exactly what a credential-stuffing run
 * wants. Known, unknown and rate-limited all read identically.
 */
describe('RecoverPage', () => {
  let requestPasswordReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestPasswordReset = vi.fn(() => Promise.resolve());
  });

  it('shows the generic confirmation and prevents duplicate submission', async () => {
    let finish!: () => void;
    const auth = {
      requestPasswordReset: vi.fn(
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
    expect(auth.requestPasswordReset).toHaveBeenCalledTimes(1);

    finish();
    await pending;
    fixture.detectChanges();
    expect(page.sent()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('If an account exists');
  });

  it('says the same thing for an address with no account', async () => {
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    const page = fixture.componentInstance;
    page.email.set('nobody@example.com');
    await page.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('If an account exists');
    expect(fixture.nativeElement.textContent).not.toContain('not found');
  });

  it('never names the address back to the page', () => {
    // Reflecting it invites a phishing screenshot that looks like ours.
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    void fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('person@example.com');
  });

  it('refuses to send with an empty address, without calling the service', async () => {
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    await fixture.componentInstance.submit();
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(fixture.componentInstance.sent()).toBe(false);
  });

  it('clears pending even when the request fails', async () => {
    const auth = { requestPasswordReset: vi.fn(() => Promise.reject(new Error('offline'))) };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    await fixture.componentInstance.submit();
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.componentInstance.sent()).toBe(false);
  });

  it('reports a transport failure as retryable, in our own words', async () => {
    const auth = {
      requestPasswordReset: vi.fn(() =>
        Promise.reject(new Error('fetch failed: ECONNREFUSED 10.0.0.4')),
      ),
    };
    const fixture = make(auth as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('ECONNREFUSED');
    expect(fixture.componentInstance.error()).toBeTruthy();
  });

  it('labels its input and disables the button while busy', () => {
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    const input = fixture.nativeElement.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const label = fixture.nativeElement.querySelector(`label[for="${input.id}"]`);
    expect(label).toBeTruthy();

    fixture.componentInstance.email.set('person@example.com');
    void fixture.componentInstance.submit();
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button[type="submit"]');
    expect(button.disabled).toBe(true);
  });

  it('announces the outcome politely rather than moving focus', async () => {
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    const live = fixture.nativeElement.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live.textContent).toContain('If an account exists');
  });

  it('offers a way to ask again after sending', async () => {
    // Mail goes missing. A dead end here sends people to support.
    const fixture = make({ requestPasswordReset } as unknown as AuthService);
    fixture.componentInstance.email.set('person@example.com');
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toMatch(/send (it )?again|try another/i);
  });
});
