import { InjectionToken } from '@angular/core';

/**
 * Leaves the app for good, to a URL Supabase (or our own sanitizer) has
 * already validated.
 *
 * Behind a token for the same reason `AUTH_CLIENT` is (see auth-service.ts):
 * assigning `location.href` directly is not something a test can observe or
 * safely trigger (jsdom has no real navigation), and Angular's vitest system
 * refuses `vi.mock` on a bare global reference anyway.
 */
export const NAVIGATE_AWAY = new InjectionToken<(url: string) => void>('NAVIGATE_AWAY', {
  providedIn: 'root',
  factory: () => (url: string) => {
    location.href = url;
  },
});
