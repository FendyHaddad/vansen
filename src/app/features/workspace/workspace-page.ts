import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideRedo2,
  lucideUndo2,
  lucideUpload,
  lucideX,
  lucideZoomIn,
  lucideZoomOut,
} from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { GenerationStore } from '../../core/generations/generation-store';
import { ProfileStore } from '../../core/profile/profile-store';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { BillingService } from '../../core/billing/billing-service';
import { JobPoller } from '../../core/jobs/job-poller';
import { ModelAvailability } from '../../core/models/model-availability';
import { ApiError } from '../../core/api/api-service';
import { clearAllCaches } from '../../core/api/local-cache';
import { MediaCache } from '../../core/media/media-cache';
import { GenerationOp } from '../../core/enums';
import { EditSession } from '../../core/editing/edit-session';
import { editToolById } from '../../core/catalog/model-families';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';
import { SettingsRail, GenerateRequest } from './settings-rail/settings-rail';
import { LibraryGrid } from './library-grid/library-grid';
import { DetailOverlay } from './detail-overlay/detail-overlay';
import { CanvasViewport } from '../studio/canvas-viewport/canvas-viewport';
import { StudioPanel } from '../studio/studio-panel/studio-panel';

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
    RouterLink,
    NgIcon,
    ProfileMenu,
    SettingsRail,
    LibraryGrid,
    DetailOverlay,
    CanvasViewport,
    StudioPanel,
  ],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideRedo2,
      lucideUndo2,
      lucideUpload,
      lucideX,
      lucideZoomIn,
      lucideZoomOut,
    }),
  ],
})
export class WorkspacePage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly profileStore = inject(ProfileStore);
  private readonly prefsService = inject(PreferencesService);
  private readonly billing = inject(BillingService);
  private readonly poller = inject(JobPoller);
  private readonly availability = inject(ModelAvailability);
  private readonly mediaCache = inject(MediaCache);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly rail = viewChild.required(SettingsRail);
  readonly viewport = viewChild(CanvasViewport);
  readonly panel = viewChild.required(StudioPanel);
  readonly editSession = inject(EditSession);

  /** 'library' shows the grid; 'edit' swaps in the canvas viewport. */
  readonly mode = signal<'library' | 'edit'>('library');

  /** Viewport magnification as a whole percent, e.g. 125 — edit toolbar. */
  readonly zoomPct = computed(() => Math.round(this.editSession.zoom() * 100));

  readonly userEmail = this.auth.userEmail;
  readonly displayName = this.profileStore.displayName;
  readonly balanceUsd = this.ledger.balanceUsd;
  readonly studioActive = this.profileStore.studioActive;
  readonly graceDaysLeft = this.profileStore.graceDaysLeft;
  readonly generations = this.store.items;
  readonly samplePrompts = SAMPLE_PROMPTS;

  /** True while the user is choosing a library item as edit reference. */
  readonly pickingReference = signal(false);

  /** Top-bar library search. */
  readonly searchTerm = signal('');

  /** True while an imported image uploads — drives the topbar spinner + overlay. */
  readonly uploading = signal(false);

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

  /** Set when 2 strikes suspend the account — blocks the whole workspace. */
  readonly suspended = signal(false);

  constructor() {
    // Deep link from the absorbed /app/edit/:id route.
    const editParam = this.route.snapshot.paramMap.get('id');
    void this.refresh().then(() => {
      this.handleCheckoutReturn();
      this.poller.watch();
      if (editParam) void this.enterEdit(editParam);
    });

    // When an AI edit on the open session's chain completes, jump to the result.
    effect(() => {
      const items = this.store.items();
      const sessionItem = this.editSession.item();
      if (this.mode() !== 'edit' || !sessionItem) return;
      const ready = items.find(
        (i) =>
          i.status === 'done' &&
          i.familyId.startsWith('edit-') &&
          i.parentId != null &&
          (i.parentId === sessionItem.id || i.parentId === sessionItem.parentId) &&
          i.id !== this.editSession.item()?.id &&
          this.aiOpened !== i.id,
      );
      if (ready) {
        this.aiOpened = ready.id;
        this.notice.set('AI edit ready — opening the result.');
        void this.enterEdit(ready.id);
      }
    });
  }

  /** Last AI-edit result auto-opened, so the effect fires once per result. */
  private aiOpened: string | null = null;

  /** Stripe redirects back with ?checkout=success|canceled; webhook may lag a second. */
  private handleCheckoutReturn(): void {
    const result = this.route.snapshot.queryParamMap.get('checkout');
    if (!result) return;
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
    if (result === 'canceled') {
      this.notice.set('Checkout canceled — nothing was charged.');
      return;
    }
    if (result !== 'success') return;
    const before = this.balanceUsd();
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      await this.profileStore.load();
      if (this.balanceUsd() !== before) {
        clearInterval(poll);
        this.notice.set(`Payment received — balance $${this.balanceUsd().toFixed(2)}.`);
      } else if (attempts >= 6) {
        clearInterval(poll);
        this.notice.set(
          'Payment received — credits are on the way. If they don’t appear, use “Didn’t receive your credits?” in Billing.',
        );
      }
    }, 1000);
  }

  private async refresh(): Promise<void> {
    try {
      await Promise.all([this.profileStore.load(), this.store.load(), this.availability.load()]);
    } catch (e) {
      this.showError(e, 'Could not load your workspace');
    }
  }

  private showError(e: unknown, fallback: string): void {
    if (e instanceof ApiError) {
      if (e.code === 'insufficient_balance') {
        this.notice.set('Balance too low — top up to continue.');
        return;
      }
      if (e.code === 'account_suspended') {
        this.suspended.set(true);
        return;
      }
      if (e.code === 'content_policy') {
        this.notice.set(
          'This request violates our content policy and was blocked. Two violations suspend your account. If this was a mistake, contact support to appeal.',
        );
        return;
      }
      if (e.code === 'model_disabled') {
        this.notice.set('That model is temporarily unavailable. Try another.');
        return;
      }
      this.notice.set(e.message);
      return;
    }
    this.notice.set(fallback);
  }

  async onGenerate(req: GenerateRequest): Promise<void> {
    const threshold = this.prefsService.prefs().confirmOverUsd;
    if (
      req.priceUsd > threshold &&
      !confirm(`This generation costs $${req.priceUsd.toFixed(2)}. Continue?`)
    ) {
      return;
    }
    const op = req.referenceId || req.referenceUploadId ? GenerationOp.Edit : GenerationOp.Generate;
    try {
      await this.store.create({
        familyId: req.family.id,
        op,
        prompt: req.prompt,
        settings: req.settings,
        batch: req.batch,
        parentId: req.referenceId ?? undefined,
        referenceUploadId: req.referenceUploadId ?? undefined,
      });
      this.rail().setReference(null);
      this.notice.set('');
      this.poller.watch();
    } catch (e) {
      this.showError(e, 'Generation failed');
    }
  }

  startReferencePick(): void {
    this.pickingReference.set(true);
  }

  /** Topbar file input — pull the file, reset input, hand off to onUpload. */
  onUploadPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.onUpload(file);
  }

  /** Import the user's own image as a library item and open it for editing. */
  async onUpload(file: File): Promise<void> {
    this.uploading.set(true);
    try {
      const item = await this.store.importImage(file);
      this.notice.set('');
      await this.enterEdit(item.id);
    } catch (e) {
      this.showError(e, 'Upload failed');
    } finally {
      this.uploading.set(false);
    }
  }

  onReferencePicked(id: string): void {
    const item = this.store.byId(id);
    if (item && item.kind === 'image') {
      this.rail().setReference({ id, uploadId: null, url: item.mediaUrl });
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

  /** Library grid delete — one card or a multi-select batch. */
  async onDeleteMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.store.remove(id);
      } catch (e) {
        this.showError(e, 'Delete failed');
        return;
      }
    }
  }

  async onDownload(id: string): Promise<void> {
    const item = this.store.byId(id);
    if (!item) return;
    // Serve from the media cache — an already-viewed image downloads free.
    let blob: Blob;
    try {
      blob = await this.mediaCache.blob(item.id, item.mediaUrl);
    } catch {
      this.notice.set('Download failed — the media link may have expired. Reload and retry.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vansen-${item.id}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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
      this.poller.watch();
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
      this.poller.watch();
    } catch (e) {
      this.showError(e, 'Variation failed');
    }
  }

  onEdit(id: string): void {
    this.openedId.set(null);
    void this.enterEdit(id);
  }

  async enterEdit(id: string): Promise<void> {
    const item = this.store.byId(id);
    if (!item || item.kind !== 'image' || item.status !== 'done') return;
    try {
      await this.editSession.open(item);
      this.mode.set('edit');
    } catch {
      this.notice.set('Could not open this image for editing.');
    }
  }

  exitEdit(): void {
    if (this.editSession.dirty() && !confirm('Discard unsaved edits?')) return;
    this.editSession.close();
    this.mode.set('library');
  }

  async onSaveEdit(): Promise<void> {
    const item = this.editSession.item();
    if (!item) return;
    try {
      const blob = await this.editSession.exportPngBlob();
      const saved = await this.store.saveEdit(blob, item.id);
      this.editSession.adoptItem(saved);
      this.notice.set('Saved as a new version.');
    } catch (e) {
      this.showError(e, 'Save failed');
    }
  }

  async onAiTool(req: {
    toolId: string;
    prompt: string;
    maskPngBase64?: string;
  }): Promise<void> {
    const item = this.editSession.item();
    if (!item) return;
    const tool = editToolById(req.toolId);
    if (!tool) return;

    try {
      // Expand: pad the canvas 25% per side; FLUX fill repaints the border mask.
      if (req.toolId === 'edit-expand') {
        await this.runExpand(item.id);
        return;
      }

      // Ai Select passes its own mask; otherwise the hand-painted mask layer.
      const mask =
        req.maskPngBase64 ?? this.viewport()?.maskCanvas()?.exportMaskPng() ?? undefined;
      if (tool.needsMask && !mask) {
        this.notice.set('Paint a mask first — the tool needs to know where to work.');
        return;
      }

      // Persist the current canvas so the AI works on what the user sees.
      const saved = this.editSession.dirty()
        ? await this.store.saveEdit(await this.editSession.exportPngBlob(), item.id)
        : item;
      if (saved.id !== item.id) this.editSession.adoptItem(saved);

      const prompt =
        req.toolId === 'edit-fill'
          ? req.prompt
          : req.toolId === 'edit-remove'
            ? 'remove the masked object and seamlessly continue the background'
            : 'remove background';
      await this.store.create({
        familyId: req.toolId,
        op: GenerationOp.Edit,
        prompt,
        settings: saved.settings,
        batch: 1,
        parentId: saved.id,
        maskPngBase64: mask,
      });
      this.viewport()?.maskCanvas()?.clear();
      this.notice.set('');
      this.poller.watch();
    } catch (e) {
      this.showError(e, 'Edit failed');
    }
  }

  private async runExpand(parentId: string): Promise<void> {
    const buf = this.editSession.current();
    if (!buf) return;
    const padX = Math.round(buf.width * 0.25);
    const padY = Math.round(buf.height * 0.25);
    const w = buf.width + padX * 2;
    const h = buf.height + padY * 2;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height),
      padX,
      padY,
    );
    const padded = await canvas.convertToBlob({ type: 'image/png' });
    const maskCanvas = new OffscreenCanvas(w, h);
    const mctx = maskCanvas.getContext('2d')!;
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, w, h);
    mctx.fillStyle = '#000';
    mctx.fillRect(padX, padY, buf.width, buf.height);
    const expandMask = await blobToDataUrl(await maskCanvas.convertToBlob({ type: 'image/png' }));

    const saved = await this.store.saveEdit(padded, parentId);
    await this.store.create({
      familyId: 'edit-expand',
      op: GenerationOp.Edit,
      prompt: 'continue the image naturally beyond its original edges',
      settings: saved.settings,
      batch: 1,
      parentId: saved.id,
      maskPngBase64: expandMask,
    });
    this.notice.set('');
    this.poller.watch();
  }

  /** Re-submit a failed generation with the same settings. */
  async onRetry(id: string): Promise<void> {
    const item = this.store.byId(id);
    if (!item) return;
    try {
      await this.store.create({
        familyId: item.familyId,
        op: item.op === 'edit' || item.op === 'upscale' ? item.op : GenerationOp.Generate,
        prompt: item.prompt,
        settings: item.settings,
        batch: 1,
        parentId: item.parentId ?? undefined,
      });
      this.notice.set('');
      this.poller.watch();
    } catch (e) {
      this.showError(e, 'Retry failed');
    }
  }

  usePrompt(value: string): void {
    this.rail().updatePrompt(value);
  }

  async topUp(): Promise<void> {
    try {
      await this.billing.checkout(20);
    } catch (e) {
      this.showError(e, 'Could not start checkout');
    }
  }

  async reactivateStudio(): Promise<void> {
    try {
      await this.billing.reactivateStudio();
    } catch (e) {
      this.showError(e, 'Could not start checkout');
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.ledger.reset();
    this.store.reset();
    this.profileStore.reset();
    this.editSession.close();
    // Wipe cached snapshots and media so nothing lingers on shared machines.
    clearAllCaches();
    void this.mediaCache.clear();
    this.router.navigate(['/']);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
