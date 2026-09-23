import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ConsentPage } from './consent-page';
import { AuthService } from '../../../core/auth/auth-service';
import { ConsentService } from './consent-service';
import { NAVIGATE_AWAY } from './navigate-away';

const CLIENT_DETAILS = {
  authorizationId: 'auth-1',
  clientName: 'Claude',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
};

function make(opts: {
  authorizationId?: string | null;
  authed?: boolean;
  consent?: Partial<ConsentService>;
}) {
  const auth = {
    whenReady: vi.fn(() => Promise.resolve()),
    isAuthed: vi.fn(() => opts.authed ?? true),
  };
  const consent = {
    load: vi.fn(() => Promise.resolve({ kind: 'details' as const, details: CLIENT_DETAILS })),
    approve: vi.fn(() => Promise.resolve('https://claude.ai/api/mcp/auth_callback?code=ok')),
    deny: vi.fn(() => Promise.resolve('https://claude.ai/api/mcp/auth_callback?error=access_denied')),
    ...opts.consent,
  };
  const navigateAway = vi.fn();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: ConsentService, useValue: consent },
      { provide: NAVIGATE_AWAY, useValue: navigateAway },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap(
              opts.authorizationId === undefined
                ? { authorization_id: 'auth-1' }
                : opts.authorizationId === null
                  ? {}
                  : { authorization_id: opts.authorizationId },
            ),
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ConsentPage);
  fixture.detectChanges();
  const router = TestBed.inject(Router);
  return { fixture, page: fixture.componentInstance, auth, consent, navigateAway, router };
}

/** Let the fire-and-forget constructor init() run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ConsentPage', () => {
  it('shows the client name, redirect host and capability list', async () => {
    const { fixture, page } = make({});
    await settle();
    fixture.detectChanges();
    expect(page.phase()).toBe('consent');
    expect(page.redirectHost()).toBe('claude.ai');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Claude');
    expect(text).toContain('claude.ai');
    expect(text).toContain('Generate images');
    expect(text).toContain('Spend your credits');
    expect(text).toContain('See your library and balance');
  });

  it('warns when the redirect target is not https', async () => {
    const { fixture, page } = make({
      consent: {
        load: vi.fn(() =>
          Promise.resolve({
            kind: 'details' as const,
            details: { ...CLIENT_DETAILS, redirectUri: 'http://127.0.0.1:6276/oauth/callback' },
          }),
        ),
      },
    });
    await settle();
    fixture.detectChanges();
    expect(page.redirectIsInsecure()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain("isn't secured with https");
  });

  it('does not warn when the redirect target is https', async () => {
    const { fixture, page } = make({});
    await settle();
    fixture.detectChanges();
    expect(page.redirectIsInsecure()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('https');
  });

  it('Allow approves and follows the redirect it gets back', async () => {
    const { page, consent, navigateAway } = make({});
    await settle();
    await page.allow();
    expect(consent.approve).toHaveBeenCalledWith('auth-1');
    expect(navigateAway).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=ok');
    expect(page.phase()).toBe('redirecting');
  });

  it('Deny denies and follows the redirect it gets back', async () => {
    const { page, consent, navigateAway } = make({});
    await settle();
    await page.deny();
    expect(consent.deny).toHaveBeenCalledWith('auth-1');
    expect(navigateAway).toHaveBeenCalledWith(
      'https://claude.ai/api/mcp/auth_callback?error=access_denied',
    );
    expect(page.phase()).toBe('redirecting');
  });

  it('an already-consented client is followed immediately, with no consent screen', async () => {
    const { page, consent, navigateAway } = make({
      consent: {
        load: vi.fn(() =>
          Promise.resolve({ kind: 'redirect' as const, url: 'https://claude.ai/cb?code=auto' }),
        ),
      },
    });
    await settle();
    expect(consent.load).toHaveBeenCalledWith('auth-1');
    expect(navigateAway).toHaveBeenCalledWith('https://claude.ai/cb?code=auto');
    expect(page.phase()).toBe('redirecting');
    expect(page.details()).toBeNull();
  });

  it('a signed-out visitor is sent to login with a return restricted to the consent page', async () => {
    const { router, auth } = make({ authed: false });
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await settle();
    expect(auth.whenReady).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/oauth/consent?authorization_id=auth-1' },
    });
  });

  it('a missing authorization_id is an error, not a blank consent screen', async () => {
    const { page, consent } = make({ authorizationId: null });
    await settle();
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toMatch(/missing/i);
    expect(consent.load).not.toHaveBeenCalled();
  });

  it('an unknown or expired authorization surfaces the vendor message as an error', async () => {
    const { fixture, page } = make({
      consent: {
        load: vi.fn(() => Promise.reject(new Error('authorization request expired'))),
      },
    });
    await settle();
    fixture.detectChanges();
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toContain('authorization request expired');
    expect(fixture.nativeElement.querySelector('a[href="/app"]')).toBeTruthy();
  });

  it('a network failure while loading is an error, not a stuck loading state', async () => {
    const { page } = make({
      consent: { load: vi.fn(() => Promise.reject(new Error('Failed to fetch'))) },
    });
    await settle();
    expect(page.phase()).toBe('error');
    expect(page.errorMessage()).toContain('Failed to fetch');
  });

  it('a failed Allow shows the error and lets the visitor try again', async () => {
    const { page, navigateAway } = make({
      consent: { approve: vi.fn(() => Promise.reject(new Error('authorization request is no longer pending'))) },
    });
    await settle();
    await page.allow();
    expect(page.phase()).toBe('consent');
    expect(page.busy()).toBe(false);
    expect(page.errorMessage()).toContain('no longer pending');
    expect(navigateAway).not.toHaveBeenCalled();
  });

  it('ignores a second Allow click while the first is in flight', async () => {
    let finish!: (url: string) => void;
    const { page, consent } = make({
      consent: {
        approve: vi.fn(() => new Promise<string>((resolve) => { finish = resolve; })),
      },
    });
    await settle();
    const first = page.allow();
    await page.allow();
    expect(consent.approve).toHaveBeenCalledTimes(1);
    finish('https://claude.ai/cb?code=ok');
    await first;
  });
});
