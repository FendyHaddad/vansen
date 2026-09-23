import { Injectable, inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../../core/auth/auth-service';
import { safeConsentReturnUrl } from './consent-return-url';

export const CONSENT_RETURN_KEY = 'vansen.consent.return';

/**
 * Carries "come back to the consent page" across a sign-in that leaves the
 * page: Google OAuth bounces through Supabase and lands on /app, and an
 * email-confirmed sign-up arrives later. Same shape as CheckoutIntent:
 * tab-scoped sessionStorage, no redirect allow-list change, taken once.
 * Both ends go through safeConsentReturnUrl, so a value planted in storage
 * can never become an open redirect. (An email link opened in a new tab
 * has an empty sessionStorage: that user retries Connect, now signed in.)
 */
@Injectable({ providedIn: 'root' })
export class ConsentReturn {
  set(raw: string | null | undefined): void {
    const safe = safeConsentReturnUrl(raw);
    if (!safe) return;
    try {
      sessionStorage.setItem(CONSENT_RETURN_KEY, safe);
    } catch {
      // Storage disabled: the user lands on /app and retries Connect.
    }
  }

  /** Reads and clears, then sanitizes again: storage is not trusted. */
  take(): string | null {
    let value: string | null = null;
    try {
      value = sessionStorage.getItem(CONSENT_RETURN_KEY);
      sessionStorage.removeItem(CONSENT_RETURN_KEY);
    } catch {
      return null;
    }
    return safeConsentReturnUrl(value);
  }
}

/** On the post-sign-in landing: a stored consent return wins, once. */
export const consentReturnGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const stash = inject(ConsentReturn);
  await auth.whenReady();
  // Signed out: authGuard answers, and the stash waits for the real landing.
  if (!auth.isAuthed()) return true;
  const url = stash.take();
  if (!url) return true;
  return router.parseUrl(url);
};
