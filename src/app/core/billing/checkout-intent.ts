import { Injectable } from '@angular/core';

const KEY = 'vansen.intent.plan';

/**
 * Carries "I clicked Get Studio while logged out" across the login hop.
 *
 * sessionStorage rather than a query param: every sign-in path (email, signup,
 * Google OAuth) lands on /app, and the OAuth leg bounces through Supabase, which
 * would drop our params and needs its redirect URLs allowlisted. The tab-scoped
 * key survives that round trip without touching auth config, and dies with the tab
 * so a stale intent can never charge someone on a later visit.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutIntent {
  set(plan: 'studio' | 'pro'): void {
    try {
      sessionStorage.setItem(KEY, plan);
    } catch {
      // Private mode / storage disabled: the visitor just lands in the workspace.
    }
  }

  /** Reads and clears — an intent must fire once, never on a later reload. */
  take(): 'studio' | 'pro' | null {
    let value: string | null = null;
    try {
      value = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
    } catch {
      return null;
    }
    return value === 'studio' || value === 'pro' ? value : null;
  }
}
