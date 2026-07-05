import { Injectable, signal } from '@angular/core';

export interface Prefs {
  defaultMode: 'image' | 'video';
  defaultImageFamily: string;
  defaultVideoFamily: string;
  defaultAspect: string;
  /** Generations priced above this ask for confirmation first. */
  confirmOverUsd: number;
}

const DEFAULTS: Prefs = {
  defaultMode: 'image',
  defaultImageFamily: 'nano-banana',
  defaultVideoFamily: 'veo',
  defaultAspect: '1:1',
  confirmOverUsd: 2,
};

const STORAGE_KEY = 'vansen.prefs';

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly state = signal<Prefs>(restore());

  readonly prefs = this.state.asReadonly();

  update(patch: Partial<Prefs>): void {
    this.state.update((p) => ({ ...p, ...patch }));
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state()));
    }
  }
}

function restore(): Prefs {
  if (typeof localStorage === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}
