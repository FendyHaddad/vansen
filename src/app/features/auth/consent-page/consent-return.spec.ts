import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../../core/auth/auth-service';
import { CONSENT_RETURN_KEY, ConsentReturn, consentReturnGuard } from './consent-return';

const CONSENT = '/oauth/consent?authorization_id=abc';

function setup(authed: boolean) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { whenReady: () => Promise.resolve(), isAuthed: () => authed } },
    ],
  });
  return TestBed.inject(ConsentReturn);
}

function runGuard() {
  return TestBed.runInInjectionContext(() =>
    consentReturnGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  ) as Promise<boolean | UrlTree>;
}

/**
 * I4: Google sign-in (and an email-confirmed sign-up) leaves through Supabase
 * and lands on /app, dropping the login page's returnUrl. The consent return
 * rides in sessionStorage across that hop and is taken once on landing.
 */
describe('ConsentReturn', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips a consent return across the sign-in hop', () => {
    const stash = setup(true);
    stash.set(CONSENT);
    expect(stash.take()).toBe(CONSENT);
  });

  it('takes once: a later landing does not bounce to consent again', () => {
    const stash = setup(true);
    stash.set(CONSENT);
    stash.take();
    expect(stash.take()).toBeNull();
  });

  it('never stores a return URL the sanitizer refuses', () => {
    const stash = setup(true);
    stash.set('https://evil.example/oauth/consent');
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
    stash.set(null);
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
  });

  it('ignores a hostile value planted in storage, and clears it', () => {
    const stash = setup(true);
    for (const hostile of ['https://evil.example/x', '//evil.example/oauth/consent', '/app/settings', 'javascript:alert(1)']) {
      sessionStorage.setItem(CONSENT_RETURN_KEY, hostile);
      expect(stash.take()).toBeNull();
      expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
    }
  });
});

describe('consentReturnGuard', () => {
  beforeEach(() => sessionStorage.clear());

  it('sends a signed-in landing on to the stored consent page', async () => {
    setup(true).set(CONSENT);
    const result = await runGuard();
    const router = TestBed.inject(Router);
    expect(result instanceof UrlTree).toBe(true);
    expect(router.serializeUrl(result as UrlTree)).toBe(CONSENT);
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
  });

  it('lets the landing through when nothing is stored', async () => {
    setup(true);
    expect(await runGuard()).toBe(true);
  });

  it('keeps the stash while signed out (the auth guard answers that)', async () => {
    setup(false).set(CONSENT);
    expect(await runGuard()).toBe(true);
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBe(CONSENT);
  });

  it('lets the landing through when the stored value is hostile', async () => {
    setup(true);
    sessionStorage.setItem(CONSENT_RETURN_KEY, 'https://evil.example/oauth/consent');
    expect(await runGuard()).toBe(true);
  });
});

describe('the post-sign-in landing', () => {
  it('runs the consent return on /app, after the auth guard', async () => {
    const { routes } = await import('../../../app.routes');
    const { authGuard } = await import('../../../core/auth/auth-guard');
    const app = routes.find((r) => r.path === 'app');
    expect(app?.canActivate?.slice(0, 2)).toEqual([authGuard, consentReturnGuard]);
  });
});
