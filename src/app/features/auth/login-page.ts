import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../core/auth/auth-service';

type AuthMode = 'signin' | 'signup';

@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton, HlmInput, HlmLabel],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly mode = signal<AuthMode>('signin');
  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly signupDone = signal(false);

  readonly submitLabel = computed(() =>
    this.mode() === 'signin' ? 'Sign in' : 'Create account',
  );

  toggleMode(): void {
    this.mode.set(this.mode() === 'signin' ? 'signup' : 'signin');
    this.error.set('');
    this.signupDone.set(false);
  }

  async signInGoogle(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.signInGoogle();
      // Supabase redirects the browser; nothing else to do here.
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Google sign-in failed');
    }
  }

  async submit(): Promise<void> {
    const email = this.email().trim();
    const password = this.password();
    if (!email || password.length < 8) {
      this.error.set('Email and a password of at least 8 characters required.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.mode() === 'signin') {
        await this.auth.signInEmail(email, password);
        await this.router.navigate(['/app']);
        return;
      }
      await this.auth.signUpEmail(email, password);
      if (this.auth.isAuthed()) {
        await this.router.navigate(['/app']);
        return;
      }
      // Email confirmation flow: account created, session arrives after confirm
      this.signupDone.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Authentication failed');
    } finally {
      this.busy.set(false);
    }
  }
}
