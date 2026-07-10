import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLogOut, lucidePlus, lucideSettings } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ProfileStore } from '../../core/profile/profile-store';

@Component({
  selector: 'app-profile-menu',
  templateUrl: './profile-menu.html',
  styleUrl: './profile-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, NgIcon, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideSettings, lucideLogOut, lucidePlus })],
})
export class ProfileMenu {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);

  /** 'avatar' = compact circle trigger; 'bar' = full-width name/email/balance row. */
  readonly variant = input<'avatar' | 'bar'>('avatar');

  readonly email = this.auth.userEmail;
  readonly displayName = this.profileStore.displayName;
  readonly initial = computed(() => (this.email().charAt(0) || '?').toUpperCase());
  readonly balanceUsd = this.ledger.balanceUsd;

  /** Studio/Pro tier badge next to the display name. Pro isn't a real
   * subscribable tier yet — flip this once it is. */
  readonly tierLabel = computed(() => (this.profileStore.studioActive() ? 'Studio' : 'Inactive'));

  readonly topUp = output<void>();
  readonly signOut = output<void>();
}
