import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../core/auth/auth-service';

/**
 * Set a new password, on the strength of a verified recovery link.
 *
 * The service holds the actual gate — a live, unexpired recovery for the
 * identity the link named. This page's job is never to imply otherwise: it
 * does not offer the form without a recovery, does not route to the app unless
 * the update succeeded, and ends the recovery when it is navigated away from.
 */
@Component({
  selector: 'app-reset-page',
  templateUrl: './reset-page.html',
  styleUrl: './reset-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton, HlmInput, HlmLabel],
})
export class ResetPage implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly password = signal('');
  readonly pending = signal(false);
  readonly error = signal('');

  /** Whether a verified link is open. Never who it was issued for. */
  readonly ready = signal(this.auth.recoveryPending());

  constructor() {
    scrubRecoveryUrl();
  }

  ngOnDestroy(): void {
    // Leaving the page ends the recovery rather than waiting out its TTL: an
    // abandoned open form should not stay usable by whoever sits down next.
    this.auth.cancelPasswordReset();
  }

  async submit(): Promise<void> {
    if (this.pending()) return;
    if (this.password().length < 8) {
      this.error.set('Use at least 8 characters.');
      return;
    }
    this.error.set('');
    this.pending.set(true);
    try {
      await this.auth.completePasswordReset(this.password());
      await this.router.navigate(['/app']);
    } catch (e) {
      this.error.set(messageOf(e));
      this.ready.set(this.auth.recoveryPending());
    } finally {
      this.pending.set(false);
    }
  }

  /** An expired link is a dead end unless the page says where to go next. */
  expired(): boolean {
    return this.error().toLowerCase().includes('expired');
  }
}

/**
 * Take the recovery code out of the address bar.
 *
 * The Supabase client has already consumed it by the time this page renders —
 * but it stays in the URL, and therefore in history, in a bookmark, and in the
 * Referer header of the next request. Anyone who gets it back can open the
 * recovery again.
 */
function scrubRecoveryUrl(): void {
  const url = new URL(location.href);
  const sensitive = ['code', 'token', 'token_hash', 'access_token', 'refresh_token', 'type'];
  const hadQuery = sensitive.some((k) => url.searchParams.has(k));
  for (const key of sensitive) url.searchParams.delete(key);
  if (!hadQuery && !url.hash) return;
  url.hash = '';
  history.replaceState(null, '', url.pathname + url.search);
}

function messageOf(e: unknown): string {
  const message = (e as { message?: string } | null)?.message;
  return message || 'Something went wrong. Please try again in a moment.';
}
