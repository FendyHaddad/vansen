import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITIES_FETCH,
  PublicCapabilitiesService,
} from './public-capabilities';

function serving(body: unknown, ok = true): PublicCapabilitiesService {
  TestBed.resetTestingModule();
  const fetchFn = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response),
  );
  TestBed.configureTestingModule({
    providers: [{ provide: CAPABILITIES_FETCH, useValue: fetchFn }],
  });
  return TestBed.inject(PublicCapabilitiesService);
}

const FULL = {
  enabledFamilyIds: ['flux', 'veo'],
  backgroundCompletion: true,
  completionNotifications: true,
  catalogVersion: '2026-09-21.1',
};

/**
 * D1: no public page may advertise something the deployment has switched off.
 */
describe('PublicCapabilitiesService', () => {
  let svc: PublicCapabilitiesService;

  beforeEach(() => {
    svc = serving(FULL);
  });

  it('promises nothing before it has an answer', () => {
    expect(svc.loaded()).toBe(false);
    expect(svc.enabledFamilyIds()).toEqual([]);
    expect(svc.backgroundCompletion()).toBe(false);
    expect(svc.familyEnabled('flux')).toBe(false);
  });

  it('reports what the server enabled', async () => {
    await svc.load();
    expect(svc.familyEnabled('flux')).toBe(true);
    expect(svc.familyEnabled('kling')).toBe(false);
    expect(svc.backgroundCompletion()).toBe(true);
  });

  it('drops a family id this client does not know', async () => {
    // A server that learns a new family before the web app is redeployed must
    // not put a raw id on a marketing page.
    svc = serving({ ...FULL, enabledFamilyIds: ['flux', 'sora'] });
    await svc.load();
    expect(svc.enabledFamilyIds()).toEqual(['flux']);
  });

  it('defaults every unverified promise off when the request fails', async () => {
    svc = serving(FULL, false);
    await svc.load();
    expect(svc.loaded()).toBe(false);
    expect(svc.backgroundCompletion()).toBe(false);
    expect(svc.enabledFamilyIds()).toEqual([]);
  });

  it('defaults off when the response is not the shape it claims', async () => {
    svc = serving({ enabledFamilyIds: 'everything' });
    await svc.load();
    expect(svc.loaded()).toBe(false);
    expect(svc.enabledFamilyIds()).toEqual([]);
  });

  it('defaults off when the fetch throws', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CAPABILITIES_FETCH, useValue: () => Promise.reject(new Error('offline')) },
      ],
    });
    const offline = TestBed.inject(PublicCapabilitiesService);
    await offline.load();
    expect(offline.loaded()).toBe(false);
  });

  it('will not promise notifications without background completion', async () => {
    svc = serving({ ...FULL, backgroundCompletion: false });
    await svc.load();
    expect(svc.completionNotifications()).toBe(false);
  });

  it('asks once however many pages ask', async () => {
    TestBed.resetTestingModule();
    const fetchFn = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(FULL) } as Response),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: CAPABILITIES_FETCH, useValue: fetchFn }],
    });
    const shared = TestBed.inject(PublicCapabilitiesService);
    await Promise.all([shared.load(), shared.load(), shared.load()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends no credentials — the route is public', async () => {
    TestBed.resetTestingModule();
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(FULL) } as Response);
    });
    let seen: RequestInit | undefined;
    TestBed.configureTestingModule({
      providers: [{ provide: CAPABILITIES_FETCH, useValue: fetchFn }],
    });
    await TestBed.inject(PublicCapabilitiesService).load();
    expect(fetchFn).toHaveBeenCalled();
    expect(seen?.headers).toBeUndefined();
  });
});
