import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch, lucideX } from '@ng-icons/lucide';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { GenerationStore } from '../../core/generations/generation-store';
import { ProfileStore } from '../../core/profile/profile-store';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { ApiError } from '../../core/api/api-service';
import { GenerationOp } from '../../core/enums';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';
import { SettingsRail, GenerateRequest } from './settings-rail/settings-rail';
import { LibraryGrid } from './library-grid/library-grid';
import { DetailOverlay } from './detail-overlay/detail-overlay';

const SAMPLE_PROMPTS = [
  'A neon-lit street in the rain, cinematic, 35mm',
  'Product shot of a perfume bottle on black marble, studio light',
  'Isometric cutaway of a cozy cabin in a snowstorm',
];

@Component({
  selector: 'app-workspace-page',
  templateUrl: './workspace-page.html',
  styleUrl: './workspace-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    RouterLink,
    NgIcon,
    HlmBadge,
    ProfileMenu,
    SettingsRail,
    LibraryGrid,
    DetailOverlay,
  ],
  providers: [provideIcons({ lucideSearch, lucideX })],
})
export class WorkspacePage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly profileStore = inject(ProfileStore);
  private readonly prefsService = inject(PreferencesService);
  private readonly router = inject(Router);

  readonly rail = viewChild.required(SettingsRail);

  readonly userEmail = this.auth.userEmail;
  readonly displayName = this.profileStore.displayName;
  readonly balanceUsd = this.ledger.balanceUsd;
  readonly studioActive = this.profileStore.studioActive;
  readonly generations = this.store.items;
  readonly samplePrompts = SAMPLE_PROMPTS;

  /** True while the user is choosing a library item as edit reference. */
  readonly pickingReference = signal(false);

  /** Top-bar library search. */
  readonly searchTerm = signal('');

  /** Open item in the detail overlay, null = closed. */
  readonly openedId = signal<string | null>(null);
  readonly openedItem = computed(() => {
    const id = this.openedId();
    return id ? (this.store.byId(id) ?? null) : null;
  });
  readonly openedParent = computed(() => {
    const parentId = this.openedItem()?.parentId;
    return parentId ? (this.store.byId(parentId) ?? null) : null;
  });

  /** Inline notice banner (errors, phase hints). */
  readonly notice = signal('');

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      await Promise.all([this.profileStore.load(), this.store.load()]);
    } catch (e) {
      this.showError(e, 'Could not load your workspace');
    }
  }

  private showError(e: unknown, fallback: string): void {
    if (e instanceof ApiError && e.code === 'insufficient_balance') {
      this.notice.set('Balance too low — top-ups arrive with Stripe in phase 2.');
      return;
    }
    this.notice.set(e instanceof ApiError ? e.message : fallback);
  }

  async onGenerate(req: GenerateRequest): Promise<void> {
    const threshold = this.prefsService.prefs().confirmOverUsd;
    if (
      req.priceUsd > threshold &&
      !confirm(`This generation costs $${req.priceUsd.toFixed(2)}. Continue?`)
    ) {
      return;
    }
    const op = req.referenceId ? GenerationOp.Edit : GenerationOp.Generate;
    try {
      await this.store.create({
        familyId: req.family.id,
        op,
        prompt: req.prompt,
        settings: req.settings,
        batch: req.batch,
        parentId: req.referenceId ?? undefined,
      });
      this.rail().setReference(null);
      this.notice.set('');
    } catch (e) {
      this.showError(e, 'Generation failed');
    }
  }

  startReferencePick(): void {
    this.pickingReference.set(true);
  }

  onReferencePicked(id: string): void {
    const item = this.store.byId(id);
    if (item && item.kind === 'image') {
      this.rail().setReference({ id, url: item.mediaUrl });
    }
    this.pickingReference.set(false);
  }

  onOpened(id: string): void {
    this.openedId.set(id);
  }

  async onDeleted(id: string): Promise<void> {
    try {
      await this.store.remove(id);
    } catch (e) {
      this.showError(e, 'Delete failed');
    }
    this.openedId.set(null);
  }

  onDownload(id: string): void {
    const item = this.store.byId(id);
    if (!item) return;
    const a = document.createElement('a');
    a.href = item.mediaUrl;
    a.download = `vansen-${item.id}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async onUpscale(id: string): Promise<void> {
    const item = this.store.byId(id);
    if (!item || item.kind !== 'image') return;
    try {
      await this.store.create({
        op: GenerationOp.Upscale,
        prompt: item.prompt,
        settings: item.settings,
        batch: 1,
        parentId: item.id,
      });
      this.notice.set('');
    } catch (e) {
      this.showError(e, 'Upscale failed');
    }
  }

  async onVariation(id: string): Promise<void> {
    const item = this.store.byId(id);
    if (!item) return;
    try {
      await this.store.create({
        familyId: item.familyId,
        op: GenerationOp.Variation,
        prompt: item.prompt,
        settings: item.settings,
        batch: 1,
      });
      this.notice.set('');
    } catch (e) {
      this.showError(e, 'Variation failed');
    }
  }

  onEdit(id: string): void {
    this.router.navigate(['/app/edit', id]);
  }

  usePrompt(value: string): void {
    this.rail().updatePrompt(value);
  }

  topUp(): void {
    this.notice.set('Top-ups arrive with Stripe in phase 2 — balance stays at $0 until then.');
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.ledger.reset();
    this.store.reset();
    this.profileStore.reset();
    this.router.navigate(['/']);
  }
}
