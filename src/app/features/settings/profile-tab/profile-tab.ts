import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { AuthService } from '../../../core/auth/auth-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { GenerationStore } from '../../../core/generations/generation-store';
import { ApiError } from '../../../core/api/api-service';

@Component({
  selector: 'app-profile-tab',
  templateUrl: './profile-tab.html',
  styleUrl: './profile-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, HlmButton, HlmInput, HlmLabel],
})
export class ProfileTab {
  private readonly auth = inject(AuthService);
  private readonly profileStore = inject(ProfileStore);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly router = inject(Router);

  readonly email = this.auth.userEmail;
  readonly profile = this.profileStore.profile;
  readonly initial = computed(() => (this.email().charAt(0) || '?').toUpperCase());
  readonly displayName = signal(this.profileStore.displayName());
  readonly saved = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly password = signal('');
  readonly passwordSaved = signal(false);
  readonly passwordError = signal('');
  readonly settingPassword = signal(false);
  readonly deleting = signal(false);

  constructor() {
    if (!this.profileStore.loaded()) {
      void this.profileStore.load().then(() => this.displayName.set(this.profileStore.displayName()));
    }
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.profileStore.updateDisplayName(this.displayName().trim());
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2000);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      this.saving.set(false);
    }
  }

  async setPassword(): Promise<void> {
    if (this.settingPassword()) return;
    this.passwordError.set('');
    const password = this.password();
    if (password.length < 8) {
      this.passwordError.set('Password must be at least 8 characters.');
      return;
    }
    this.settingPassword.set(true);
    try {
      await this.auth.setPassword(password);
      this.password.set('');
      this.passwordSaved.set(true);
      setTimeout(() => this.passwordSaved.set(false), 2000);
    } catch (e) {
      this.passwordError.set(e instanceof Error ? e.message : 'Could not set password');
    } finally {
      this.settingPassword.set(false);
    }
  }

  async deleteAccount(): Promise<void> {
    if (this.deleting()) return;
    if (!confirm('Delete your account? Library, balance, and history are wiped. This cannot be undone.')) {
      return;
    }
    this.deleting.set(true);
    this.error.set('');
    try {
      await this.profileStore.deleteAccount();
      await this.auth.signOut();
      this.ledger.reset();
      this.store.reset();
      this.router.navigate(['/']);
      // Stay "deleting" — navigation replaces this view.
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Delete failed');
      this.deleting.set(false);
    }
  }
}
