import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import { ProfileDto, ProfileResponse, SubscriptionDto } from '../api/dtos';
import { SubscriptionPlan, SubscriptionStatus } from '../enums';
import { LedgerService } from '../ledger/ledger-service';
import { PreferencesService } from '../preferences/preferences-service';
import { currentUid, readCache, writeCache } from '../api/local-cache';

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
    if (!sub) return false;
    // 'canceled' still runs until the paid period ends
    if (sub.status === SubscriptionStatus.Expired) return false;
    return !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  });

  /** Hidden internal tier — unlimited credits, never surfaced as a plan name. */
  readonly isOwner = computed(() => {
    const sub = this.subscriptionSig();
    return !!sub && sub.plan === SubscriptionPlan.Owner && sub.status !== SubscriptionStatus.Expired;
  });

  /** Pro benefits: pro or owner plan, not expired past its paid period. */
  readonly proActive = computed(() => {
    const sub = this.subscriptionSig();
    if (!sub) return false;
    if (sub.plan !== SubscriptionPlan.Pro && sub.plan !== SubscriptionPlan.Owner) return false;
    if (sub.status === SubscriptionStatus.Expired) return false;
    return !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  });

  /** Days left in the 30-day post-lapse grace window; null when not lapsed/out of grace. */
  readonly graceDaysLeft = computed(() => {
    const sub = this.subscriptionSig();
    if (!sub || !sub.currentPeriodEnd) return null;
    const ended = new Date(sub.currentPeriodEnd).getTime();
    if (this.studioActive() || ended > Date.now()) return null;
    const left = 30 - Math.floor((Date.now() - ended) / 86_400_000);
    return left > 0 ? left : null;
  });

  async load(): Promise<void> {
    // Boot from the last snapshot (profile, settings, balance) instantly,
    // then always revalidate — balance can change server-side any time.
    const cacheKey = `profile.${await currentUid()}`;
    if (!this.loadedSig()) {
      const cached = readCache<ProfileResponse>(cacheKey);
      if (cached) this.apply(cached);
    }
    const response = await this.api.get<ProfileResponse>('/profile');
    this.apply(response);
    writeCache(cacheKey, response);
  }

  private apply(response: ProfileResponse): void {
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
