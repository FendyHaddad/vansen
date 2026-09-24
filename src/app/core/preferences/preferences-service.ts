import { Injectable, inject, signal } from '@angular/core';
import { SessionLifecycle } from '../auth/session-lifecycle';
import { ApiService } from '../api/api-service';
import type { VideoMode } from '../catalog/model-families';

export interface Prefs {
  defaultMode: 'image' | 'video';
  defaultImageFamily: string;
  defaultVideoFamily: string;
  defaultVideoMode: VideoMode;
  defaultAspect: string;
  /** Persona id preselected in the left panel ('' = none). */
  defaultPersona: string;
  /** True once the onboarding tour was finished or skipped. */
  tourSeen: boolean;
}

const DEFAULTS: Prefs = {
  defaultMode: 'image',
  defaultImageFamily: 'nano-banana',
  defaultVideoFamily: 'veo',
  defaultVideoMode: 't2v',
  defaultAspect: '1:1',
  defaultPersona: '',
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

  constructor() {
    inject(SessionLifecycle).register('preferences', this);
  }

  /**
   * Identity changed: fall back to defaults and drop the cached copy. These
   * are per-account settings held in localStorage — the next person to sign
   * in on this browser must not inherit them.
   */
  reset(): void {
    this.state.set({ ...DEFAULTS });
    clearCache();
  }

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

function clearCache(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // private mode / denied storage — nothing to clear
  }
}
