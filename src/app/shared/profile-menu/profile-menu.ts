import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLogOut, lucidePlus, lucideSettings } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';

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

  readonly email = this.auth.userEmail;
  readonly initial = computed(() => (this.email().charAt(0) || '?').toUpperCase());
  readonly balanceUsd = this.ledger.balanceUsd;

  readonly topUp = output<void>();
  readonly signOut = output<void>();
}
