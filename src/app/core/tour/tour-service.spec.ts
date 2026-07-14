import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { PreferencesService } from '../preferences/preferences-service';
import { ProfileStore } from '../profile/profile-store';
import { TOUR_STEPS, TourService } from './tour-service';

describe('TourService', () => {
  const prefsMock = { update: vi.fn().mockResolvedValue(undefined) };
  const planSig = signal<'studio' | 'pro' | 'owner' | null>('studio');
  const profileMock = { plan: planSig };

  function make(): TourService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PreferencesService, useValue: prefsMock },
        { provide: ProfileStore, useValue: profileMock },
      ],
    });
    return TestBed.inject(TourService);
  }

  beforeEach(() => {
    prefsMock.update.mockClear();
    planSig.set('studio');
  });

  it('start() activates at step 0', () => {
    const tour = make();
    tour.start();
    expect(tour.active()).toBe(true);
    expect(tour.activeIndex()).toBe(0);
    expect(tour.current().id).toBe('welcome');
  });

  it('next() advances; past the last step it finishes and persists tourSeen', () => {
    const tour = make();
    tour.start();
    for (let i = 0; i < tour.visibleSteps().length - 1; i++) tour.next();
    expect(tour.activeIndex()).toBe(tour.visibleSteps().length - 1);
    tour.next();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });

  it('prev() clamps at 0', () => {
    const tour = make();
    tour.start();
    tour.prev();
    expect(tour.activeIndex()).toBe(0);
  });

  it('skip() deactivates and persists tourSeen', () => {
    const tour = make();
    tour.start();
    tour.skip();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });

  it('rewrites the credits step for the subscription model', () => {
    const credits = TOUR_STEPS.find((s) => s.id === 'credits')!;
    expect(credits.body).toContain('reset');
    expect(credits.body).toContain('roll over');
  });

  it('shows the subscribe step only to non-subscribers', () => {
    const tour = make();
    planSig.set(null);
    expect(tour.visibleSteps().some((s) => s.id === 'subscribe')).toBe(true);
    planSig.set('studio');
    expect(tour.visibleSteps().some((s) => s.id === 'subscribe')).toBe(false);
  });
});
