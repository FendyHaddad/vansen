import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login-page';
import { AuthService } from '../../core/auth/auth-service';
import { AppleAuthAvailability } from '../../core/auth/apple-auth-availability';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';
import { CONSENT_RETURN_KEY } from './consent-page/consent-return';

const capabilities = { load: vi.fn(() => Promise.resolve()), enabledFamilyIds: () => [] };

function make(
  returnUrl: string | null,
  auth: Partial<AuthService>,
  appleEnabled = false,
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: PublicCapabilitiesService, useValue: capabilities },
      {
        provide: AppleAuthAvailability,
        useValue: { load: vi.fn(() => Promise.resolve()), enabled: () => appleEnabled },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}),
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(LoginPage);
  fixture.detectChanges();
  const router = TestBed.inject(Router);
  return { fixture, page: fixture.componentInstance, router };
}

/**
 * The `returnUrl` query param exists for exactly one caller: the consent page
 * sending a signed-out visitor to log in and come back. Anything else it
 * could name — another origin, a different in-app page — must land on `/app`
 * instead, or a link to our own login page becomes a way to redirect
 * somewhere else entirely after "logging in".
 */
describe('LoginPage return URL', () => {
  it('honors a return to the consent page after signing in', async () => {
    const auth = { signInEmail: vi.fn(() => Promise.resolve()) };
    const { page, router } = make('/oauth/consent?authorization_id=abc', auth);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(auth.signInEmail).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('/oauth/consent?authorization_id=abc');
  });

  it('refuses an external host smuggled in as returnUrl and falls back to /app', async () => {
    const auth = { signInEmail: vi.fn(() => Promise.resolve()) };
    const { page, router } = make('https://evil.example/take-over', auth);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(nav).toHaveBeenCalledWith('/app');
  });

  it('refuses a protocol-relative returnUrl and falls back to /app', async () => {
    const auth = { signInEmail: vi.fn(() => Promise.resolve()) };
    const { page, router } = make('//evil.example/oauth/consent', auth);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(nav).toHaveBeenCalledWith('/app');
  });

  it('refuses a different in-app path and falls back to /app', async () => {
    const auth = { signInEmail: vi.fn(() => Promise.resolve()) };
    const { page, router } = make('/app/settings', auth);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(nav).toHaveBeenCalledWith('/app');
  });

  it('goes to /app with no returnUrl at all', async () => {
    const auth = { signInEmail: vi.fn(() => Promise.resolve()) };
    const { page, router } = make(null, auth);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(nav).toHaveBeenCalledWith('/app');
  });
});

/** I4: the Google and email-confirmation legs leave the page, so the consent
 * return is stashed (sanitized) before they do. */
describe('LoginPage consent return across the Supabase hop', () => {
  beforeEach(() => sessionStorage.clear());

  it('stashes the consent return before Google sign-in leaves the page', async () => {
    let storedAtCall: string | null = 'not called';
    const auth = {
      signInGoogle: vi.fn(() => {
        storedAtCall = sessionStorage.getItem(CONSENT_RETURN_KEY);
        return Promise.resolve();
      }),
    };
    const { page } = make('/oauth/consent?authorization_id=abc', auth);
    await page.signInGoogle();
    expect(storedAtCall).toBe('/oauth/consent?authorization_id=abc');
  });

  it('stashes nothing for Google sign-in with a hostile returnUrl', async () => {
    const auth = { signInGoogle: vi.fn(() => Promise.resolve()) };
    const { page } = make('https://evil.example/oauth/consent', auth);
    await page.signInGoogle();
    expect(auth.signInGoogle).toHaveBeenCalled();
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
  });

  it('stashes the consent return when sign-up waits for email confirmation', async () => {
    const auth = { signUpEmail: vi.fn(() => Promise.resolve()), isAuthed: () => false };
    const { page } = make('/oauth/consent?authorization_id=abc', auth as unknown as Partial<AuthService>);
    page.toggleMode();
    page.email.set('person@example.com');
    page.password.set('a-good-password');
    await page.submit();
    expect(page.signupDone()).toBe(true);
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBe('/oauth/consent?authorization_id=abc');
  });
});

/**
 * The Apple button must track the hosted project's own answer: never shown
 * on a promise the deployment cannot keep, and — when shown — behaving
 * exactly like the Google button (same redirect leg, same consent-return
 * stash) since Supabase treats both as ordinary OAuth providers.
 */
describe('LoginPage Apple sign-in', () => {
  beforeEach(() => sessionStorage.clear());

  it('hides the Apple button when the provider is not enabled', () => {
    const { fixture } = make(null, {}, false);
    const button: HTMLElement | null = fixture.nativeElement.querySelector('.apple-btn');
    expect(button).toBeNull();
  });

  it('shows the Apple button when the provider is enabled', () => {
    const { fixture } = make(null, {}, true);
    const button: HTMLElement | null = fixture.nativeElement.querySelector('.apple-btn');
    expect(button).not.toBeNull();
  });

  it('stashes the consent return before Apple sign-in leaves the page', async () => {
    let storedAtCall: string | null = 'not called';
    const auth = {
      signInWithApple: vi.fn(() => {
        storedAtCall = sessionStorage.getItem(CONSENT_RETURN_KEY);
        return Promise.resolve();
      }),
    };
    const { page } = make('/oauth/consent?authorization_id=abc', auth, true);
    await page.signInApple();
    expect(storedAtCall).toBe('/oauth/consent?authorization_id=abc');
  });

  it('stashes nothing for Apple sign-in with a hostile returnUrl', async () => {
    const auth = { signInWithApple: vi.fn(() => Promise.resolve()) };
    const { page } = make('https://evil.example/oauth/consent', auth, true);
    await page.signInApple();
    expect(auth.signInWithApple).toHaveBeenCalled();
    expect(sessionStorage.getItem(CONSENT_RETURN_KEY)).toBeNull();
  });

  it('surfaces an Apple sign-in failure without getting stuck busy', async () => {
    const auth = { signInWithApple: vi.fn(() => Promise.reject(new Error('popup blocked'))) };
    const { page } = make(null, auth, true);
    await page.signInApple();
    expect(page.error()).toBe('popup blocked');
    expect(page.appleBusy()).toBe(false);
  });
});
