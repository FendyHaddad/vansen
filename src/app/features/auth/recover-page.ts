import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../core/auth/auth-service';

/**
 * Ask for a password-reset email.
 *
 * Every submission gets the same answer. Telling someone their address has no
 * account is a free account-enumeration oracle — the exact list a
 * credential-stuffing run wants — so known, unknown and rate-limited addresses
 * are indistinguishable from this page.
 */
@Component({
  selector: 'app-recover-page',
  templateUrl: './recover-page.html',
  styleUrl: './recover-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton, HlmInput, HlmLabel],
})
export class RecoverPage {
  private readonly auth = inject(AuthService);

  readonly email = signal('');
  readonly pending = signal(false);
  readonly sent = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    if (this.pending()) return;
    if (!this.email().trim()) {
      this.error.set('Enter the email address you signed up with.');
      return;
    }
    this.error.set('');
    this.pending.set(true);
    try {
      await this.auth.requestPasswordReset(this.email());
      this.sent.set(true);
    } catch {
      // The service already stripped the vendor's wording; anything that
      // reaches here means we never got to ask, which is worth retrying.
      this.error.set('Something went wrong. Please try again in a moment.');
    } finally {
      this.pending.set(false);
    }
  }

  /** Mail goes missing. A dead end after sending just creates support tickets. */
  again(): void {
    this.sent.set(false);
  }
}
