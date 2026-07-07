import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import { ProfileDto, ProfileResponse, SubscriptionDto } from '../api/dtos';
import { SubscriptionStatus } from '../enums';
import { LedgerService } from '../ledger/ledger-service';
import { PreferencesService } from '../preferences/preferences-service';

@Injectable({ providedIn: 'root' })
export class ProfileStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly prefsService = inject(PreferencesService);

  private readonly profileSig = signal<ProfileDto | null>(null);
  private readonly subscriptionSig = signal<SubscriptionDto | null>(null);
  private readonly loadedSig = signal(false);

  readonly profile = this.profileSig.asReadonly();
  readonly subscription = this.subscriptionSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  readonly displayName = computed(() => this.profileSig()?.displayName ?? '');
  readonly studioActive = computed(() => {
    const sub = this.subscriptionSig();
    if (!sub || sub.status !== SubscriptionStatus.Active) return false;
    return !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  });

  async load(): Promise<void> {
    const response = await this.api.get<ProfileResponse>('/profile');
    this.profileSig.set(response.profile);
    this.subscriptionSig.set(response.subscription);
    this.ledger.setBalance(response.balanceUsd);
    this.prefsService.applyServerPrefs(response.profile.prefs);
    this.loadedSig.set(true);
  }

  async updateDisplayName(displayName: string): Promise<void> {
    await this.api.patch('/profile', { displayName });
    const current = this.profileSig();
    if (current) this.profileSig.set({ ...current, displayName });
  }

  async deleteAccount(): Promise<void> {
    await this.api.delete('/profile');
    this.reset();
  }

  reset(): void {
    this.profileSig.set(null);
    this.subscriptionSig.set(null);
    this.loadedSig.set(false);
  }
}
