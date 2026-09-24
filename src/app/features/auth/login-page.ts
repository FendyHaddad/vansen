import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../core/auth/auth-service';
import { AppleAuthAvailability } from '../../core/auth/apple-auth-availability';
import { MODEL_FAMILIES } from '../../core/catalog/model-families';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';
import { safeConsentReturnUrl } from './consent-page/consent-return-url';
import { ConsentReturn } from './consent-page/consent-return';

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
  private readonly route = inject(ActivatedRoute);
  private readonly capabilities = inject(PublicCapabilitiesService);
  private readonly consentReturn = inject(ConsentReturn);
  private readonly appleAuth = inject(AppleAuthAvailability);

  constructor() {
    void this.capabilities.load();
    void this.appleAuth.load();
  }

  /** The splash caption named Sora, which has no adapter. Live families only. */
  readonly modelCaption = computed(() => {
    const enabled = this.capabilities.enabledFamilyIds();
    return MODEL_FAMILIES.filter((f) => enabled.includes(f.id))
      .map((f) => f.name)
      .join(' · ');
  });

  readonly mode = signal<AuthMode>('signin');
  readonly email = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly googleBusy = signal(false);
  readonly appleBusy = signal(false);
  readonly signupDone = signal(false);

  /** Shown only once GoTrue itself reports the provider configured. */
  readonly appleEnabled = computed(() => this.appleAuth.enabled());

  readonly submitLabel = computed(() =>
    this.mode() === 'signin' ? 'Sign in' : 'Create account',
  );

  /**
   * Where to go after a successful sign-in.
   *
   * Only ever `/app`, or a `returnUrl` naming our own consent page — never a
   * caller-supplied destination taken at face value. See consent-return-url.ts.
   */
  private postLoginUrl(): string {
    return safeConsentReturnUrl(this.rawReturnUrl()) ?? '/app';
  }

  private rawReturnUrl(): string | null {
    return this.route.snapshot.queryParamMap.get('returnUrl');
  }

  toggleMode(): void {
    this.mode.set(this.mode() === 'signin' ? 'signup' : 'signin');
    this.error.set('');
    this.signupDone.set(false);
  }

  async signInGoogle(): Promise<void> {
    if (this.googleBusy()) return;
    this.googleBusy.set(true);
    this.error.set('');
    // Google comes back to /app, not here: carry the consent return over.
    this.consentReturn.set(this.rawReturnUrl());
    try {
      await this.auth.signInGoogle();
      // Supabase redirects the browser; stay busy until the page unloads.
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Google sign-in failed');
      this.googleBusy.set(false);
    }
  }

  async signInApple(): Promise<void> {
    if (this.appleBusy()) return;
    this.appleBusy.set(true);
    this.error.set('');
    // Apple comes back to /app, not here: carry the consent return over, same
    // as Google.
    this.consentReturn.set(this.rawReturnUrl());
    try {
      await this.auth.signInWithApple();
      // Supabase redirects the browser; stay busy until the page unloads.
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Apple sign-in failed');
      this.appleBusy.set(false);
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
        await this.router.navigateByUrl(this.postLoginUrl());
        return;
      }
      await this.auth.signUpEmail(email, password);
      if (this.auth.isAuthed()) {
        await this.router.navigateByUrl(this.postLoginUrl());
        return;
      }
      // Email confirmation flow: account created, session arrives after confirm
      this.consentReturn.set(this.rawReturnUrl());
      this.signupDone.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Authentication failed');
    } finally {
      this.busy.set(false);
    }
  }
}
