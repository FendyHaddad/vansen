import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideActivity,
  lucideArrowLeft,
  lucideCreditCard,
  lucidePlugZap,
  lucideSlidersHorizontal,
  lucideUser,
} from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';
import { ProfileTab } from './profile-tab/profile-tab';
import { BillingTab } from './billing-tab/billing-tab';
import { UsageTab } from './usage-tab/usage-tab';
import { PreferencesTab } from './preferences-tab/preferences-tab';
import { ConnectedTab } from './connected-tab/connected-tab';

type SettingsTab = 'profile' | 'billing' | 'usage' | 'preferences' | 'connected';

interface TabEntry {
  id: SettingsTab;
  label: string;
  icon: string;
  hint: string;
}

const TABS: TabEntry[] = [
  { id: 'profile', label: 'Profile', icon: 'lucideUser', hint: 'Identity and account' },
  { id: 'billing', label: 'Subscription', icon: 'lucideCreditCard', hint: 'Plan, credits, invoices' },
  { id: 'usage', label: 'Usage', icon: 'lucideActivity', hint: 'This month at a glance' },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: 'lucideSlidersHorizontal',
    hint: 'Defaults for the workspace',
  },
  {
    id: 'connected',
    label: 'Connected assistants',
    icon: 'lucidePlugZap',
    hint: 'Claude, ChatGPT and MCP',
  },
];

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
    ConnectedTab,
  ],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideUser,
      lucideCreditCard,
      lucideActivity,
      lucideSlidersHorizontal,
      lucidePlugZap,
    }),
  ],
})
export class SettingsPage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly router = inject(Router);
  private readonly profileStore = inject(ProfileStore);
  private readonly caps = inject(PublicCapabilitiesService);

  readonly totalCredits = this.ledger.totalCredits;
  readonly isOwner = this.profileStore.isOwner;

  readonly active = signal<SettingsTab>('profile');

  /** Connected assistants only while the deployment has MCP_ENABLED on:
   * with it off, /mcp answers 503 and the grant list cannot load. */
  readonly tabs = computed(() =>
    TABS.filter((t) => t.id !== 'connected' || this.caps.assistantConnection()),
  );

  /** The tab actually shown: a hidden tab (a stale deep link) falls back. */
  readonly shown = computed<SettingsTab>(() => {
    const active = this.active();
    return this.tabs().some((t) => t.id === active) ? active : 'profile';
  });

  constructor() {
    void this.caps.load();
    // Deep link: the workspace "Buy credits" entry points at ?tab=billing.
    const tab = inject(ActivatedRoute).snapshot.queryParamMap.get('tab');
    if (
      tab === 'billing' ||
      tab === 'usage' ||
      tab === 'preferences' ||
      tab === 'profile' ||
      tab === 'connected'
    ) {
      this.active.set(tab);
    }
  }

  /** Profile-menu "Buy credits" — packs live on the Billing tab. */
  topUp(): void {
    this.active.set('billing');
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.router.navigate(['/']);
  }
}
