import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';

export interface Prefs {
  defaultMode: 'image' | 'video';
  defaultImageFamily: string;
  defaultVideoFamily: string;
  defaultAspect: string;
  /** Generations priced above this ask for confirmation first. */
  confirmOverUsd: number;
  /** True once the onboarding tour was finished or skipped. */
  tourSeen: boolean;
}

const DEFAULTS: Prefs = {
  defaultMode: 'image',
  defaultImageFamily: 'nano-banana',
  defaultVideoFamily: 'veo',
  defaultAspect: '1:1',
  confirmOverUsd: 2,
  tourSeen: false,
};

const CACHE_KEY = 'vansen.prefs';

/**
 * Server-backed preferences (profiles.prefs jsonb) with a localStorage cache
 * so the workspace boots instantly with the last known values.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly api = inject(ApiService);
  private readonly state = signal<Prefs>(restoreCache());

  readonly prefs = this.state.asReadonly();

  /** Called by ProfileStore when the server profile arrives. */
  applyServerPrefs(serverPrefs: Record<string, unknown>): void {
    const merged = { ...DEFAULTS, ...(serverPrefs as Partial<Prefs>) };
    this.state.set(merged);
    persistCache(merged);
  }

  async update(patch: Partial<Prefs>): Promise<void> {
    const next = { ...this.state(), ...patch };
    this.state.set(next);
    persistCache(next);
    await this.api.put('/prefs', next);
  }
}

function restoreCache(): Prefs {
  if (typeof localStorage === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

function persistCache(prefs: Prefs): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
}
