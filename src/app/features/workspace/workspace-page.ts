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
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { GenerationStore } from '../../core/generations/generation-store';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { upscaleUserPriceUsd } from '../../core/catalog/model-families';
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
    HlmButton,
    HlmBadge,
    ProfileMenu,
    SettingsRail,
    LibraryGrid,
    DetailOverlay,
  ],
})
export class WorkspacePage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly prefsService = inject(PreferencesService);
  private readonly router = inject(Router);

  readonly rail = viewChild.required(SettingsRail);

  readonly user = this.auth.user;
  readonly balanceUsd = this.ledger.balanceUsd;
  readonly studioActive = this.auth.studioActive;
  readonly generations = this.store.items;
  readonly samplePrompts = SAMPLE_PROMPTS;

  /** True while the user is choosing a library item as edit reference. */
  readonly pickingReference = signal(false);

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

  onGenerate(req: GenerateRequest): void {
    const threshold = this.prefsService.prefs().confirmOverUsd;
    if (
      req.priceUsd > threshold &&
      !confirm(`This generation costs $${req.priceUsd.toFixed(2)}. Continue?`)
    ) {
      return;
    }
    const op = req.referenceId || req.referenceUrl ? 'edit' : 'generate';
    if (!this.ledger.charge(op, req.priceUsd, req.family.id, req.family.name)) return;
    this.store.add({
      kind: req.family.kind,
      familyId: req.family.id,
      familyName: req.family.name,
      op,
      prompt: req.prompt,
      settings: req.settings,
      priceUsd: req.priceUsd,
      // Edits reuse the reference image so provenance is visible in the stub
      mediaUrl: op === 'edit' && req.referenceUrl ? req.referenceUrl : this.store.placeholderFor(),
      parentId: req.referenceId ?? undefined,
    });
    this.rail().setReference(null);
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

  onDeleted(id: string): void {
    this.store.remove(id);
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

  onUpscale(id: string): void {
    const item = this.store.byId(id);
    if (!item || item.kind !== 'image') return;
    const price = upscaleUserPriceUsd();
    if (!this.ledger.charge('upscale', price, 'magnific', 'Magnific Precision v2')) return;
    this.store.add({
      kind: 'image',
      familyId: 'magnific',
      familyName: 'Magnific Precision v2',
      op: 'upscale',
      prompt: item.prompt,
      settings: item.settings,
      priceUsd: price,
      mediaUrl: item.mediaUrl,
      parentId: item.id,
    });
  }

  onVariation(id: string): void {
    const item = this.store.byId(id);
    if (!item) return;
    if (!this.ledger.charge('generate', item.priceUsd, item.familyId, `${item.familyName} · variation`)) return;
    this.store.add({
      kind: item.kind,
      familyId: item.familyId,
      familyName: item.familyName,
      op: 'variation',
      prompt: item.prompt,
      settings: item.settings,
      priceUsd: item.priceUsd,
      mediaUrl: this.store.placeholderFor(),
      parentId: item.id,
    });
  }

  onEdit(id: string): void {
    this.router.navigate(['/app/edit', id]);
  }

  usePrompt(value: string): void {
    this.rail().updatePrompt(value);
  }

  topUp(): void {
    // Stub: real flow goes through Stripe Checkout
    this.ledger.add({ type: 'topup', amountUsd: 20, note: 'Top-up' });
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/']);
  }
}
