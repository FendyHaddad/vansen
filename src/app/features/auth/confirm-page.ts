import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../core/auth/auth-service';

/**
 * Resend a signup confirmation.
 *
 * Same contract as the recovery form, for the same reason: whether an address
 * has an unconfirmed account is the same private fact as whether it has an
 * account at all.
 */
@Component({
  selector: 'app-confirm-page',
  templateUrl: './confirm-page.html',
  styleUrl: './confirm-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton, HlmInput, HlmLabel],
})
export class ConfirmPage {
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
      await this.auth.resendConfirmation(this.email());
      this.sent.set(true);
    } catch {
      this.error.set('Something went wrong. Please try again in a moment.');
    } finally {
      this.pending.set(false);
    }
  }

  again(): void {
    this.sent.set(false);
  }
}
