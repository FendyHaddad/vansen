import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { TourService } from '../../core/tour/tour-service';
import { TourOverlay } from './tour-overlay';

describe('TourOverlay', () => {
  const prefsMock = { update: vi.fn().mockResolvedValue(undefined) };
  const profileMock = { plan: signal<'studio' | null>('studio') };

  beforeEach(() => {
    prefsMock.update.mockClear();
    profileMock.plan.set('studio');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PreferencesService, useValue: prefsMock },
        { provide: ProfileStore, useValue: profileMock },
      ],
    });
  });

  it('skips steps whose target is missing (none exist here → tour finishes)', () => {
    const tour = TestBed.inject(TourService);
    tour.start();
    const fixture = TestBed.createComponent(TourOverlay);
    fixture.detectChanges();
    // Welcome (no target) stays; advancing hits only missing targets → finish.
    tour.next();
    fixture.detectChanges();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });

  it('Escape skips the tour', () => {
    const tour = TestBed.inject(TourService);
    tour.start();
    const fixture = TestBed.createComponent(TourOverlay);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tour.active()).toBe(false);
  });
});
