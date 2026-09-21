import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { Session, SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../supabase/supabase-client';
import { clearAllCaches } from '../api/local-cache';
import { SessionLifecycle } from './session-lifecycle';

/**
 * The Supabase auth client, injected rather than imported.
 *
 * Angular's vitest system refuses `vi.mock` on a relative import, so the only
 * way to exercise the teardown this service drives is to hand it its client.
 */
export const AUTH_CLIENT = new InjectionToken<SupabaseClient['auth']>('AUTH_CLIENT', {
  providedIn: 'root',
  factory: () => supabase.auth,
});

/**
 * How long a verified recovery stays usable.
 *
 * Long enough to pick a password and correct a typo, short enough that walking
 * away from an open laptop does not leave the account resettable.
 */
const RECOVERY_TTL_MS = 30 * 60_000;

/** What the reset form is allowed to act on. Never a token, never an email. */
interface RecoveryGrant {
  userId: string;
  expiresAt: number;
}

/** One message for every failure a customer can do nothing about. */
const GENERIC_RETRY = 'Something went wrong. Please try again in a moment.';

/** The only redirect targets we will ever ask the vendor to mail out. */
function recoveryRedirect(path: '/reset' | '/confirm'): string {
  // Deliberately not a query parameter or a caller-supplied return URL: that
  // would turn our own recovery email into a way to deliver someone else's
  // code to an attacker's page.
  return `${location.origin}${path}`;
}

/**
 * Real Supabase auth. Session/SSO only — profile data (display name, studio,
 * balance) lives in the API-backed stores, not here.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(AUTH_CLIENT);
  private readonly lifecycle = inject(SessionLifecycle);
  private readonly sessionSig = signal<Session | null>(null);
  private readonly readyPromise: Promise<void>;

  /**
   * Set ONLY by a verified PASSWORD_RECOVERY event.
   *
   * A signed-in session is not permission to set a password: without this,
   * anyone already authenticated could open /reset and change their password
   * with no link, and A opening B's link could change a password from an email
   * addressed to B.
   */
  private readonly recovery = signal<RecoveryGrant | null>(null);

  readonly session = this.sessionSig.asReadonly();
  readonly isAuthed = computed(() => this.sessionSig() !== null);
  readonly userEmail = computed(() => this.sessionSig()?.user.email ?? '');
  readonly userSince = computed(() => this.sessionSig()?.user.created_at ?? '');

  constructor() {
    // The localStorage snapshots are per-account and survive a reload, so
    // they are torn down with everything else rather than by one page.
    this.lifecycle.register('local-cache', { reset: () => clearAllCaches() });
    this.readyPromise = this.auth.getSession().then(async ({ data }) => {
      this.sessionSig.set(data.session);
      await this.lifecycle.onIdentityChange(data.session?.user.id ?? null);
    });
    // Every identity change — including an expiry, a server-side revocation,
    // and a sign-out performed in ANOTHER TAB — arrives here. Teardown used to
    // live in one page's click handler, so none of those cases cleaned up.
    this.auth.onAuthStateChange((event, session) => {
      this.sessionSig.set(session);
      this.onRecoveryEvent(event, session);
      void this.lifecycle.onIdentityChange(session?.user.id ?? null);
    });
  }

  /** Guards await this so a page refresh restores the session before routing. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  async signInGoogle(): Promise<void> {
    const { error } = await this.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/app` },
    });
    if (error) throw new Error(error.message);
  }

  async signInEmail(email: string, password: string): Promise<void> {
    const { error } = await this.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  async signUpEmail(email: string, password: string): Promise<void> {
    const { error } = await this.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
  }

  /** Sets (or replaces) the account password — lets OAuth-only users add
   * email+password sign-in. Requires a live session. */
  async setPassword(password: string): Promise<void> {
    const { error } = await this.auth.updateUser({ password });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }

  /** True while a verified reset link is open. Says nothing about whose. */
  recoveryPending(): boolean {
    const grant = this.recovery();
    return !!grant && grant.expiresAt > Date.now();
  }

  /**
   * Ask for a reset email.
   *
   * Resolves the same way for every address. A form that says "no account with
   * that email" is an account-enumeration oracle, and it is the whole list an
   * attacker needs. The vendor's own errors — unknown user, rate limited — are
   * swallowed for exactly that reason; only a failure that means "we could not
   * ask at all" is reported, and then without the vendor's wording.
   */
  async requestPasswordReset(email: string): Promise<void> {
    await this.sendQuietly(() =>
      this.auth.resetPasswordForEmail(normalizeEmail(email), {
        redirectTo: recoveryRedirect('/reset'),
      }),
    );
  }

  /** Same contract as requestPasswordReset, for an unconfirmed signup. */
  async resendConfirmation(email: string): Promise<void> {
    await this.sendQuietly(() =>
      this.auth.resend({
        type: 'signup',
        email: normalizeEmail(email),
        options: { emailRedirectTo: recoveryRedirect('/confirm') },
      }),
    );
  }

  /**
   * Set the new password, but only for the identity the verified link named.
   *
   * Three separate gates, because each one alone has been a real CVE in
   * somebody's app: a live recovery, an unexpired one, and a session whose
   * user is the one that recovery was issued for.
   */
  async completePasswordReset(password: string): Promise<void> {
    const grant = this.recovery();
    if (!grant) throw new Error('Open a valid reset link to continue.');
    if (grant.expiresAt <= Date.now()) {
      this.recovery.set(null);
      throw new Error('That reset link has expired. Request a new one.');
    }
    if (password.length < 8) throw new Error('Use at least 8 characters.');

    const { data, error: sessionError } = await this.auth.getSession();
    if (sessionError || data.session?.user.id !== grant.userId) {
      throw new Error('Open a valid reset link to continue.');
    }

    const { error } = await this.auth.updateUser({ password });
    // The grant survives a failed update on purpose: a transient error should
    // let the customer press the button again, not send them back to their
    // mailbox for a fresh link.
    if (error) {
      throw new Error('The password could not be updated. Please try again.');
    }
    this.recovery.set(null);
  }

  /** Leaving the reset page ends the recovery — it does not wait for the TTL. */
  cancelPasswordReset(): void {
    this.recovery.set(null);
  }

  /**
   * A recovery is created by the vendor's own verified event and by nothing
   * else. Every other transition ends it: signing out, an expiry, or a
   * different identity arriving.
   */
  private onRecoveryEvent(event: string, session: Session | null): void {
    if (event === 'PASSWORD_RECOVERY' && session?.user.id) {
      this.recovery.set({
        userId: session.user.id,
        expiresAt: Date.now() + RECOVERY_TTL_MS,
      });
      return;
    }
    const grant = this.recovery();
    if (!grant) return;
    if (session?.user.id === grant.userId) return;
    this.recovery.set(null);
  }

  /**
   * Run a vendor call whose outcome must not be observable.
   *
   * A returned error is swallowed: it is the vendor telling us something about
   * the address, which is the thing we refuse to disclose. A thrown error means
   * we never reached them, which is safe to report — but never in their words,
   * which carry hosts, addresses and implementation detail.
   */
  private async sendQuietly(call: () => Promise<{ error: unknown }>): Promise<void> {
    try {
      await call();
    } catch {
      throw new Error(GENERIC_RETRY);
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
