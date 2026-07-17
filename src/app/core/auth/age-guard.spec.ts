import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth-service';
import { ProfileStore } from '../profile/profile-store';
import { ageGuard, onboardingGuard } from './age-guard';

function setup(authed: boolean, ageConfirmed: boolean, loaded = false) {
  const auth = { whenReady: vi.fn().mockResolvedValue(undefined), isAuthed: () => authed };
  const store = {
    load: vi.fn().mockResolvedValue(undefined),
    ageConfirmed: () => ageConfirmed,
    loaded: () => loaded,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: ProfileStore, useValue: store },
    ],
  });
  const router = TestBed.inject(Router);
  return { store, router };
}

describe('ageGuard', () => {
  it('allows a confirmed user through (loads when store is cold)', async () => {
    const { store } = setup(true, true);
    const result = await TestBed.runInInjectionContext(() => ageGuard({} as any, {} as any));
    expect(store.load).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('skips the network round-trip once loaded and confirmed', async () => {
    const { store } = setup(true, true, true);
    const result = await TestBed.runInInjectionContext(() => ageGuard({} as any, {} as any));
    expect(store.load).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('redirects an un-gated user to /onboarding', async () => {
    const { store } = setup(true, false);
    const result = await TestBed.runInInjectionContext(() => ageGuard({} as any, {} as any));
    expect(store.load).toHaveBeenCalled();
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).toString()).toBe('/onboarding');
  });
});

describe('onboardingGuard', () => {
  it('lets an un-gated user see the onboarding screen', async () => {
    setup(true, false);
    const result = await TestBed.runInInjectionContext(() => onboardingGuard({} as any, {} as any));
    expect(result).toBe(true);
  });

  it('redirects a confirmed user back to /app', async () => {
    setup(true, true);
    const result = await TestBed.runInInjectionContext(() => onboardingGuard({} as any, {} as any));
    expect((result as UrlTree).toString()).toBe('/app');
  });
});
