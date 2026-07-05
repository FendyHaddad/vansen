import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../../core/auth/auth-service';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { GenerationStore } from '../../../core/generations/generation-store';

@Component({
  selector: 'app-profile-tab',
  templateUrl: './profile-tab.html',
  styleUrl: './profile-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, HlmButton, HlmInput, HlmLabel],
})
export class ProfileTab {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly router = inject(Router);

  readonly user = this.auth.user;
  readonly initial = computed(() => (this.user()?.email.charAt(0) ?? '?').toUpperCase());
  readonly displayName = signal(this.auth.user()?.displayName ?? '');
  readonly saved = signal(false);

  save(): void {
    this.auth.updateProfile({ displayName: this.displayName().trim() });
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 2000);
  }

  deleteAccount(): void {
    if (!confirm('Delete your account? Library, balance, and history are wiped. This cannot be undone.')) {
      return;
    }
    this.ledger.reset();
    this.store.clear();
    this.auth.signOut();
    this.router.navigate(['/']);
  }
}
