import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login-page';
import { AuthService } from '../../core/auth/auth-service';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';

const capabilities = { load: vi.fn(() => Promise.resolve()), enabledFamilyIds: () => [] };

function make(returnUrl: string | null, auth: Partial<AuthService>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: PublicCapabilitiesService, useValue: capabilities },
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
