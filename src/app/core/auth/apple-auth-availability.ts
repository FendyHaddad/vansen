import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * Overridable in tests. Same shape as the anonymous fetch used elsewhere
 * (see PublicCapabilitiesService) — no session token, this is a public
 * settings read.
 */
export const APPLE_AUTH_FETCH = new InjectionToken<typeof fetch>('APPLE_AUTH_FETCH', {
  providedIn: 'root',
  factory: () => (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
});

/**
 * Whether the hosted Supabase project has Sign in with Apple switched on.
 *
 * There is no build-time flag for this: whether Apple is configured lives in
 * the Supabase dashboard, and a Services ID / key can be added or pulled
 * without a redeploy of this app. Asking GoTrue's own public settings
 * endpoint — the same one supabase-js itself would consult to discover
 * enabled providers — is the only way the button can track that without
 * lying in either direction. Showing the button when the provider is not
 * configured sends a customer into a dead OAuth redirect; hiding it when the
 * provider *is* configured just costs a sign-in option, which is why every
 * failure mode below resolves to "hidden" rather than "shown".
 *
 * Cached for the tab's lifetime: the setting cannot change mid-session, so
 * every page that mounts the button reuses one answer instead of re-asking.
 */
@Injectable({ providedIn: 'root' })
export class AppleAuthAvailability {
  private readonly fetchFn = inject(APPLE_AUTH_FETCH);
  private readonly enabledSig = signal(false);
  private inFlight: Promise<void> | null = null;
  private settled = false;

  readonly enabled = computed(() => this.enabledSig());

  /** Safe to call from several pages at once; the request happens once per session. */
  load(): Promise<void> {
    if (this.settled) return Promise.resolve();
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    try {
      const res = await this.fetchFn(`${environment.supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: environment.supabaseAnonKey },
      });
      if (!res.ok) {
        this.enabledSig.set(false);
        return;
      }
      const body = (await res.json()) as { external?: { apple?: unknown } } | null;
      this.enabledSig.set(body?.external?.apple === true);
    } catch {
      // Offline, blocked, or a gateway error. Hidden is the safe answer.
      this.enabledSig.set(false);
    } finally {
      this.settled = true;
    }
  }
}
