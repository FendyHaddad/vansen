import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { AuthService } from '../../../core/auth/auth-service';
import { ConsentDetails, ConsentService } from './consent-service';
import { safeConsentReturnUrl } from './consent-return-url';
import { NAVIGATE_AWAY } from './navigate-away';

type Phase = 'loading' | 'signing-in' | 'consent' | 'redirecting' | 'error';

/** What connecting an assistant lets it do, per the design spec (§2, §4). */
const CAPABILITIES = ['Generate images', 'Spend your credits', 'See your library and balance'];

/**
 * The OAuth consent screen an assistant's sign-in flow lands on
 * (`GET /oauth/consent?authorization_id=…`).
 *
 * Three things make this page different from a normal form: a signed-out
 * visitor has to detour through login and back without becoming an
 * open-redirect (see `consent-return-url.ts`); a client the user already
 * approved comes back as a ready-made `redirect_url` that must be followed
 * immediately, not shown a screen; and Allow/Deny both end by leaving the
 * app entirely, for a URL Supabase already validated against the client's
 * registered redirect URI.
 */
@Component({
  selector: 'app-consent-page',
  templateUrl: './consent-page.html',
  styleUrl: './consent-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton],
})
export class ConsentPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly consent = inject(ConsentService);
  private readonly navigateAway = inject(NAVIGATE_AWAY);

  private authorizationId = '';

  readonly phase = signal<Phase>('loading');
  readonly details = signal<ConsentDetails | null>(null);
  readonly errorMessage = signal('');
  readonly busy = signal(false);

  readonly capabilities = CAPABILITIES;

  readonly redirectHost = computed(() => {
    const uri = this.details()?.redirectUri;
    if (!uri) return '';
    try {
      return new URL(uri).host;
    } catch {
      return uri;
    }
  });

  readonly redirectIsInsecure = computed(() => {
    const uri = this.details()?.redirectUri;
    return !!uri && !uri.startsWith('https://');
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    const authorizationId = this.route.snapshot.queryParamMap.get('authorization_id');
    if (!authorizationId) {
      this.fail('This connection link is missing information. Ask the assistant to reconnect.');
      return;
    }
    this.authorizationId = authorizationId;

    await this.auth.whenReady();
    if (!this.auth.isAuthed()) {
      this.phase.set('signing-in');
      const returnUrl = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
      // Round-tripped through the same sanitizer the login page applies on
      // the way back, so this is provably the one path it will ever honor.
      await this.router.navigate(['/login'], {
        queryParams: { returnUrl: safeConsentReturnUrl(returnUrl) },
      });
      return;
    }

    try {
      const outcome = await this.consent.load(authorizationId);
      if (outcome.kind === 'redirect') {
        this.phase.set('redirecting');
        this.navigateAway(outcome.url);
        return;
      }
      this.details.set(outcome.details);
      this.phase.set('consent');
    } catch (e) {
      this.fail(messageOf(e));
    }
  }

  async allow(): Promise<void> {
    await this.decide(() => this.consent.approve(this.authorizationId));
  }

  async deny(): Promise<void> {
    await this.decide(() => this.consent.deny(this.authorizationId));
  }

  private async decide(call: () => Promise<string>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.errorMessage.set('');
    try {
      const url = await call();
      this.phase.set('redirecting');
      this.navigateAway(url);
    } catch (e) {
      this.errorMessage.set(messageOf(e));
      this.busy.set(false);
    }
  }

  private fail(message: string): void {
    this.phase.set('error');
    this.errorMessage.set(message);
  }
}

function messageOf(e: unknown): string {
  const message = (e as { message?: string } | null)?.message;
  return message || 'Something went wrong. Please try again in a moment.';
}
