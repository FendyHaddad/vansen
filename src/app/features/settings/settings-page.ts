import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideActivity,
  lucideArrowLeft,
  lucideCreditCard,
  lucideSlidersHorizontal,
  lucideUser,
} from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';
import { ProfileTab } from './profile-tab/profile-tab';
import { BillingTab } from './billing-tab/billing-tab';
import { UsageTab } from './usage-tab/usage-tab';
import { PreferencesTab } from './preferences-tab/preferences-tab';

type SettingsTab = 'profile' | 'billing' | 'usage' | 'preferences';

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    RouterLink,
    NgIcon,
    ProfileMenu,
    ProfileTab,
    BillingTab,
    UsageTab,
    PreferencesTab,
  ],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideUser,
      lucideCreditCard,
      lucideActivity,
      lucideSlidersHorizontal,
    }),
  ],
})
export class SettingsPage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly router = inject(Router);

  readonly balanceUsd = this.ledger.balanceUsd;

  readonly active = signal<SettingsTab>('profile');
  readonly tabs: { id: SettingsTab; label: string; icon: string; hint: string }[] = [
    { id: 'profile', label: 'Profile', icon: 'lucideUser', hint: 'Identity and account' },
    { id: 'billing', label: 'Billing', icon: 'lucideCreditCard', hint: 'Balance, Studio, history' },
    { id: 'usage', label: 'Usage', icon: 'lucideActivity', hint: 'This month at a glance' },
    {
      id: 'preferences',
      label: 'Preferences',
      icon: 'lucideSlidersHorizontal',
      hint: 'Defaults for the workspace',
    },
  ];

  topUp(): void {
    this.ledger.add({ type: 'topup', amountUsd: 20, note: 'Top-up' });
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/']);
  }
}
