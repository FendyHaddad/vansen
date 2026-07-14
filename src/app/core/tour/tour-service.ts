import { Injectable, computed, inject, signal } from '@angular/core';
import { PreferencesService } from '../preferences/preferences-service';
import { ProfileStore } from '../profile/profile-store';

export interface TourStep {
  id: 'welcome' | 'left-panel' | 'library' | 'right-panel' | 'credits' | 'bell' | 'subscribe';
  /** data-tour attribute value; null = centered card, no spotlight. */
  target: string | null;
  title: string;
  body: string;
  placement: 'right' | 'left' | 'top' | 'bottom' | 'center';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    target: null,
    placement: 'center',
    title: 'Welcome to Vansen',
    body: 'A 90-second tour of the studio. You can skip at any time.',
  },
  {
    id: 'left-panel',
    target: 'left-panel',
    placement: 'right',
    title: 'Create here',
    body: 'Describe it, pick a model, hit Generate. Everything you make starts here.',
  },
  {
    id: 'library',
    target: 'library',
    placement: 'top',
    title: 'Your library',
    body: 'Your creations land here. Click any image to edit, upscale, or make variations.',
  },
  {
    id: 'right-panel',
    target: 'right-panel',
    placement: 'left',
    title: 'Studio tools',
    body: 'Heal, cut out, expand, and more — the editing tools live in this panel.',
  },
  {
    id: 'credits',
    target: 'credits',
    placement: 'top',
    title: 'Credits & billing',
    body: 'Your monthly credits reset each billing cycle; add-on pack credits roll over while subscribed. Failed generations are refunded automatically.',
  },
  {
    id: 'bell',
    target: 'bell',
    placement: 'bottom',
    title: 'Notifications',
    body: "Refunds and job updates show up here. That's it — start creating.",
  },
  {
    id: 'subscribe',
    target: null,
    placement: 'center',
    title: 'Pick your plan',
    body: 'Studio $15/mo (1,500 credits) or Pro $30/mo (3,750 credits + video). Launch offer: $10/$25 for your first 60 days.',
  },
];

/** Spotlight onboarding tour state. Finish/skip persists prefs.tourSeen. */
@Injectable({ providedIn: 'root' })
export class TourService {
  private readonly prefs = inject(PreferencesService);
  private readonly profile = inject(ProfileStore);

  /** Subscribed users (and owner) never see the subscribe beat. */
  readonly visibleSteps = computed(() =>
    this.profile.plan() ? TOUR_STEPS.filter((s) => s.id !== 'subscribe') : TOUR_STEPS,
  );
  readonly activeIndex = signal(0);
  readonly active = signal(false);
  readonly current = computed(() => this.visibleSteps()[this.activeIndex()]);

  start(): void {
    this.activeIndex.set(0);
    this.active.set(true);
  }

  next(): void {
    if (this.activeIndex() >= this.visibleSteps().length - 1) {
      this.finish();
      return;
    }
    this.activeIndex.update((i) => i + 1);
  }

  prev(): void {
    this.activeIndex.update((i) => Math.max(0, i - 1));
  }

  skip(): void {
    this.stop();
  }

  finish(): void {
    this.stop();
  }

  private stop(): void {
    this.active.set(false);
    void this.prefs.update({ tourSeen: true });
  }
}
