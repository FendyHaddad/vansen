import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ApiService, ApiError } from '../../core/api/api-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { AuthService } from '../../core/auth/auth-service';
import { isAdult } from '../../core/onboarding/age';

type Step = 'form' | 'confirm' | 'rejected';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

@Component({
  selector: 'app-onboarding-page',
  templateUrl: './onboarding-page.html',
  styleUrl: './onboarding-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButton, HlmLabel],
})
export class OnboardingPage {
  private readonly api = inject(ApiService);
  private readonly profile = inject(ProfileStore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly step = signal<Step>('form');
  readonly year = signal('');
  readonly month = signal('');
  readonly day = signal('');
  readonly busy = signal(false);
  readonly error = signal('');

  // Neutral pickers: no "must be 18" hint anywhere in the labels or ranges.
  readonly years = (() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 120 }, (_, i) => String(now - i));
  })();
  readonly months = MONTH_NAMES.map((label, i) => ({ value: String(i + 1), label }));
  readonly days = Array.from({ length: 31 }, (_, i) => String(i + 1));

  /** Zero-padded YYYY-MM-DD, or '' when the picked date doesn't exist (Feb 30). */
  private birthDate(): string {
    const y = this.year(), m = this.month(), d = this.day();
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const dt = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== Number(d)) return '';
    return iso;
  }

  async submit(): Promise<void> {
    if (!this.year() || !this.month() || !this.day()) {
      this.error.set('Please choose your full date of birth.');
      return;
    }
    const dob = this.birthDate();
    if (!dob) {
      this.error.set('That date doesn’t exist — please check it.');
      return;
    }
    this.error.set('');
    // Local pre-check only decides whether to warn. Server is authoritative.
    if (!isAdult(dob)) {
      this.step.set('confirm');
      return;
    }
    await this.send(dob);
  }

  /** Second step of the two-step confirm — user acknowledged the delete. */
  async confirmDelete(): Promise<void> {
    const dob = this.birthDate();
    if (dob) await this.send(dob);
  }

  cancelConfirm(): void {
    this.step.set('form');
  }

  /** Escape hatch: a user unwilling to give a DOB must not be trapped here. */
  async signOutInstead(): Promise<void> {
    this.profile.reset();
    await this.auth.signOut();
    await this.router.navigate(['/']);
  }

  private async send(dob: string): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post('/profile/age', { birthDate: dob });
      await this.profile.load();
      await this.router.navigate(['/app']);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'underage') {
        this.profile.reset();
        await this.auth.signOut();
        this.step.set('rejected');
        return;
      }
      this.step.set('form');
      this.error.set(e instanceof Error ? e.message : 'Something went wrong — try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
