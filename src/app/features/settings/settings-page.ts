import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft } from '@ng-icons/lucide';
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
  providers: [provideIcons({ lucideArrowLeft })],
})
export class SettingsPage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly router = inject(Router);

  readonly balanceUsd = this.ledger.balanceUsd;

  readonly active = signal<SettingsTab>('profile');
  readonly tabs: { id: SettingsTab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'billing', label: 'Billing' },
    { id: 'usage', label: 'Usage' },
    { id: 'preferences', label: 'Preferences' },
  ];

  topUp(): void {
    this.ledger.add({ type: 'topup', amountUsd: 20, note: 'Top-up' });
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/']);
  }
}
