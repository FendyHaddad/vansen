import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { environment } from '../../../environments/environment';
import { APPLE_AUTH_FETCH, AppleAuthAvailability } from './apple-auth-availability';

function serving(body: unknown, ok = true): AppleAuthAvailability {
  TestBed.resetTestingModule();
  const fetchFn = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response),
  );
  TestBed.configureTestingModule({
    providers: [{ provide: APPLE_AUTH_FETCH, useValue: fetchFn }],
  });
  return TestBed.inject(AppleAuthAvailability);
}

/**
 * The Apple button must never be shown on a promise the hosted project cannot
 * keep: every failure mode here — disabled, malformed, unreachable — has to
 * resolve to hidden, the same discipline PublicCapabilitiesService applies to
 * the marketing pages.
 */
describe('AppleAuthAvailability', () => {
  it('is hidden before an answer arrives', () => {
    const svc = serving({ external: { apple: true } });
    expect(svc.enabled()).toBe(false);
  });

  it('shows once GoTrue reports the provider enabled', async () => {
    const svc = serving({ external: { apple: true } });
    await svc.load();
    expect(svc.enabled()).toBe(true);
  });

  it('stays hidden when GoTrue reports the provider disabled', async () => {
    const svc = serving({ external: { apple: false } });
    await svc.load();
    expect(svc.enabled()).toBe(false);
  });

  it('stays hidden when the provider is absent from the response', async () => {
    const svc = serving({ external: {} });
    await svc.load();
    expect(svc.enabled()).toBe(false);
  });

  it('stays hidden on a truthy-but-not-boolean value', async () => {
    const svc = serving({ external: { apple: 'true' } });
    await svc.load();
    expect(svc.enabled()).toBe(false);
  });

  it('stays hidden when the request fails', async () => {
    const svc = serving({ external: { apple: true } }, false);
    await svc.load();
    expect(svc.enabled()).toBe(false);
  });

  it('stays hidden when the fetch throws', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: APPLE_AUTH_FETCH, useValue: () => Promise.reject(new Error('offline')) },
      ],
    });
    const svc = TestBed.inject(AppleAuthAvailability);
    await svc.load();
    expect(svc.enabled()).toBe(false);
  });

  it('reads GoTrue settings with the anon apikey header, no session token', async () => {
    let seenUrl: RequestInfo | URL | undefined;
    let seenInit: RequestInit | undefined;
    TestBed.resetTestingModule();
    const fetchFn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ external: { apple: true } }),
      } as Response);
    });
    TestBed.configureTestingModule({
      providers: [{ provide: APPLE_AUTH_FETCH, useValue: fetchFn }],
    });
    await TestBed.inject(AppleAuthAvailability).load();
    expect(seenUrl).toBe(`${environment.supabaseUrl}/auth/v1/settings`);
    expect(seenInit?.headers).toEqual({ apikey: environment.supabaseAnonKey });
  });

  it('asks once however many pages ask, including after it has already settled', async () => {
    TestBed.resetTestingModule();
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ external: { apple: true } }),
      } as Response),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: APPLE_AUTH_FETCH, useValue: fetchFn }],
    });
    const shared = TestBed.inject(AppleAuthAvailability);
    await Promise.all([shared.load(), shared.load(), shared.load()]);
    await shared.load();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
