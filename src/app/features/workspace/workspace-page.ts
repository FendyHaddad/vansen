// Top-level workspace route: library grid + generate rail in library mode,
// canvas viewport + tool rail in edit mode. Generation/billing/notice logic
// lives in the component-scoped `WorkspaceGenerationActions`,
// `WorkspaceBillingActions` and `WorkspaceNotices` (injected below) — this
// file owns mode switching and wiring those services to the template.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucidePlus,
  lucideRedo2,
  lucideUndo2,
  lucideUpload,
  lucideX,
  lucideZoomIn,
  lucideZoomOut,
} from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { GenerationStore, type GenerationItem } from '../../core/generations/generation-store';
import { ProfileStore } from '../../core/profile/profile-store';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { JobPoller } from '../../core/jobs/job-poller';
import { ModelAvailability } from '../../core/models/model-availability';
import { EditToolCatalog } from '../../core/catalog/edit-tool-catalog';
import type { RetryableDto } from '../../core/api/dtos';
import { referenceRoutingFor } from './reference-routing';
import { EditSession } from '../../core/editing/edit-session';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';
import { NotificationBell } from '../../shared/notification-bell/notification-bell';
import { NotificationToast } from '../../shared/notification-toast/notification-toast';
import { TourService } from '../../core/tour/tour-service';
import { TourOverlay } from '../../shared/tour-overlay/tour-overlay';
import { LeftPanel, GenerateRequest } from './left-panel/left-panel';
import { RenderingChip } from './rendering-chip/rendering-chip';
import { LibraryGrid } from './library-grid/library-grid';
import { DetailOverlay } from './detail-overlay/detail-overlay';
import { CanvasViewport } from '../studio/canvas-viewport/canvas-viewport';
import { RightPanel } from '../studio/right-panel/right-panel';
import { PlanChangeDialog } from '../studio/plan-change-dialog/plan-change-dialog';
import { CreditPacksDialog } from './credit-packs-dialog/credit-packs-dialog';
import { PersonaManager } from './persona-manager/persona-manager';
import { VideoPickerDialog } from './video-picker-dialog/video-picker-dialog';
import { PersonaStore } from '../../core/personas/persona-store';
import { ConfirmService } from '../../shared/confirm/confirm-service';
import { WorkspaceNotices } from './workspace-notices';
import { WorkspaceGenerationActions } from './workspace-generation-actions';
import { WorkspaceBillingActions } from './workspace-billing-actions';

// Re-exported so existing specs (model-disabled-notice.spec.ts,
// live-announcements.spec.ts) keep importing from this path.
export { modelDisabledNotice, announcementFor } from './workspace-notices';

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
    ProfileMenu,
    NotificationBell,
    NotificationToast,
    RenderingChip,
    TourOverlay,
    LeftPanel,
    LibraryGrid,
    DetailOverlay,
    CanvasViewport,
    RightPanel,
    PlanChangeDialog,
    CreditPacksDialog,
    PersonaManager,
    VideoPickerDialog,
  ],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucidePlus,
      lucideRedo2,
      lucideUndo2,
      lucideUpload,
      lucideX,
      lucideZoomIn,
      lucideZoomOut,
    }),
    WorkspaceNotices,
    WorkspaceGenerationActions,
    WorkspaceBillingActions,
  ],
})
export class WorkspacePage {
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(GenerationStore);
  private readonly personaStore = inject(PersonaStore);
  /** Public: the plan-change dialog reads subscription state straight from it. */
  readonly profileStore = inject(ProfileStore);
  private readonly prefsService = inject(PreferencesService);
  private readonly poller = inject(JobPoller);
  private readonly availability = inject(ModelAvailability);
  /** AI edit tools' served plan floors — the right panel's lock state waits on it too. */
  private readonly editToolCatalog = inject(EditToolCatalog);
  readonly tour = inject(TourService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmService);

  /** Public: the notice banner, suspension flag and live-region announcer —
   * the template binds to these directly. */
  readonly notices = inject(WorkspaceNotices);
  /** Public: submit/retry/upscale/variation/delete/download/AI-edit actions
   * and the shared per-item busy set — the template binds to these directly. */
  readonly actions = inject(WorkspaceGenerationActions);
  /** Public: subscribe/plan-change/checkout-return handling — the template
   * binds to these directly. */
  readonly billing = inject(WorkspaceBillingActions);

  readonly rail = viewChild.required(LeftPanel);
  readonly viewport = viewChild(CanvasViewport);
  readonly panel = viewChild.required(RightPanel);
  readonly editSession = inject(EditSession);

  /** 'library' shows the grid; 'edit' swaps in the canvas viewport. */
  readonly mode = signal<'library' | 'edit'>('library');

  /** Viewport magnification as a whole percent, e.g. 125 — edit toolbar. */
  readonly zoomPct = computed(() => Math.round(this.editSession.zoom() * 100));

  readonly userEmail = this.auth.userEmail;
  readonly displayName = this.profileStore.displayName;
  readonly totalCredits = this.ledger.totalCredits;
  /** Plan bucket only — the credits a mid-cycle switch would replace. */
  readonly planCredits = this.ledger.planCredits;
  readonly isOwner = this.profileStore.isOwner;
  readonly studioActive = this.profileStore.studioActive;
  readonly daysUntilPurge = this.profileStore.daysUntilPurge;
  readonly generations = this.store.items;
  readonly hasMoreItems = this.store.hasMore;
  readonly loadingMoreItems = this.store.loadingMore;
  readonly pendingVideoCount = this.store.pendingVideoCount;
  readonly samplePrompts = SAMPLE_PROMPTS;

  /** True while the user is choosing a library item as edit reference. */
  readonly pickingReference = signal(false);

  /** Top-bar library search. */
  readonly searchTerm = signal('');

  /** True while an imported image uploads — drives the topbar spinner + overlay. */
  readonly uploading = signal(false);

  /** Open item in the detail overlay, null = closed. */
  readonly openedId = signal<string | null>(null);
  /** Server's answer for the open item. Off until it says otherwise. */
  readonly retryable = signal<RetryableDto>({ retry: false, variation: false });
  readonly openedItem = computed(() => {
    const id = this.openedId();
    return id ? (this.store.byId(id) ?? null) : null;
  });
  readonly openedParent = computed(() => {
    const parentId = this.openedItem()?.parentId;
    return parentId ? (this.store.byId(parentId) ?? null) : null;
  });

  /** True while a generate request is in flight — the rail button shows progress. */
  readonly generating = signal(false);

  /** Captured once at construction, before the title effect ever touches it. */
  private readonly baseTitle = document.title;

  constructor() {
    // The router guard cannot see a tab close or a reload. This is the only
    // hook the browser offers, and it only counts when the handler is
    // registered while the canvas is genuinely dirty.
    effect((onCleanup) => {
      if (!this.editSession.dirty()) return;
      const warn = (e: BeforeUnloadEvent) => e.preventDefault();
      addEventListener('beforeunload', warn);
      onCleanup(() => removeEventListener('beforeunload', warn));
    });

    // Deep link from the absorbed /app/edit/:id route.
    const editParam = this.route.snapshot.paramMap.get('id');
    void this.refresh().then(() => {
      this.billing.handleCheckoutReturn();
      this.poller.watch();
      if (editParam) void this.enterEdit(editParam);
      else if (!this.billing.resumeCheckoutIntent()) this.maybeStartTour();
    });

    // Tab title reflects pending video renders while any are in flight.
    effect((onCleanup) => {
      const n = this.pendingVideoCount();
      document.title = n > 0 ? `(${n}) Rendering… · ${this.baseTitle}` : this.baseTitle;
      onCleanup(() => {
        document.title = this.baseTitle;
      });
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
      if (!ready) return;
      this.aiOpened = ready.id;
      // Opening it would replace the canvas. If there is unsaved work on it,
      // that is the customer's to decide — the result is in the library
      // either way.
      if (this.editSession.dirty()) {
        this.notices.notice.set('AI edit ready — it is in your library.');
        return;
      }
      this.notices.notice.set('AI edit ready — opening the result.');
      void this.enterEdit(ready.id);
    });
  }

  /** Last AI-edit result auto-opened, so the effect fires once per result. */
  private aiOpened: string | null = null;

  private async refresh(): Promise<void> {
    try {
      await Promise.all([
        this.profileStore.load(),
        this.store.load(),
        this.availability.load(),
        this.editToolCatalog.load(),
      ]);
    } catch (e) {
      this.notices.showError(e, 'Could not load your workspace');
    }
  }

  async onGenerate(req: GenerateRequest): Promise<void> {
    if (this.generating()) return;
    const routing = referenceRoutingFor(req);
    this.generating.set(true);
    try {
      await this.actions.submit(
        {
          familyId: req.family.id,
          op: routing.op,
          prompt: req.prompt,
          style: req.style ?? undefined,
          personaId: req.personaId ?? undefined,
          trendId: req.trendId ?? undefined,
          settings: req.settings,
          batch: req.batch,
          parentId: routing.parentId,
          referenceUploadId: routing.referenceUploadId,
          referencePaths: req.referencePaths,
        },
        () => this.rail().setReference(null),
      );
    } catch (e) {
      this.notices.showError(e, 'Generation failed', !!req.personaId);
    } finally {
      this.generating.set(false);
    }
  }

  startReferencePick(): void {
    this.pickingReference.set(true);
  }

  /** Video parent picker (extend / edit modes). */
  readonly videoPickerOpen = signal(false);

  onVideoPicked(item: GenerationItem): void {
    this.rail().setVideoParent(item);
    this.videoPickerOpen.set(false);
  }

  /** Extend / Edit → from the detail overlay: hand the clip to the left panel
   * as a video follow-up and close the overlay. */
  onVideoFollowUp(item: GenerationItem, mode: 'extend' | 'edit'): void {
    this.openedId.set(null);
    this.rail().startVideoFollowUp(item, mode);
  }

  readonly personaManagerOpen = signal(false);

  openPersonaManager(): void {
    this.personaManagerOpen.set(true);
    void this.personaStore.load();
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
      this.notices.notice.set('');
      await this.enterEdit(item.id);
    } catch (e) {
      this.notices.showError(e, 'Upload failed');
    } finally {
      this.uploading.set(false);
    }
  }

  async onReferencePicked(id: string): Promise<void> {
    const item = await this.store.fetchById(id);
    if (item && item.kind === 'image') {
      this.rail().setReference({ id, uploadId: null, url: item.mediaUrl });
    }
    this.pickingReference.set(false);
  }

  /**
   * A grid row carries a thumbnail, not the original. Opening it fetches the
   * signed media — and its parent's, because the detail view shows both.
   */
  async onOpened(id: string): Promise<void> {
    this.openedId.set(id);
    // Assume nothing until the server answers: a control that turns out to be
    // dead is worse than one that appears a moment late.
    this.retryable.set({ retry: false, variation: false });
    void this.loadRetryable(id);
    const item = await this.store.fetchById(id);
    if (item?.parentId) void this.store.fetchById(item.parentId);
  }

  /** What the open item can actually do, and why not when it cannot. */
  private async loadRetryable(id: string): Promise<void> {
    try {
      const answer = await this.store.retryable(id);
      if (this.openedId() === id) this.retryable.set(answer);
    } catch {
      // The probe is an affordance, not the operation. If it cannot be
      // reached, leave the controls off rather than promising anything.
    }
  }

  /** The library asked for the next page — the end of the grid is in view. */
  onMoreWanted(): void {
    void this.store.loadMore();
  }

  async onDeleted(id: string): Promise<void> {
    await this.actions.deleteOne(id, () => this.openedId.set(null));
  }

  onEdit(id: string): void {
    this.openedId.set(null);
    void this.enterEdit(id);
  }

  async enterEdit(id: string): Promise<void> {
    const item = await this.store.fetchById(id);
    if (!item || item.kind !== 'image' || item.status !== 'done') return;
    // Switching images inside the workspace never leaves the route, so the
    // router guard cannot see it. Ask here too.
    if (!(await this.confirmDiscard())) return;
    try {
      await this.editSession.open(item);
      this.mode.set('edit');
    } catch {
      this.notices.notice.set('Could not open this image for editing.');
    }
  }

  async exitEdit(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.editSession.close();
    this.mode.set('library');
  }

  /** True when there is nothing to lose, or the customer said to go ahead. */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.editSession.dirty()) return true;
    return await this.confirm.ask({
      title: 'Discard unsaved edits?',
      body: 'Your edits to this image have not been saved. Continuing discards them.',
      confirmLabel: 'Discard edits',
      cancelLabel: 'Keep editing',
      destructive: true,
    });
  }

  async onAiTool(req: { toolId: string; prompt: string; maskPngBase64?: string }): Promise<void> {
    await this.actions.aiTool(
      req,
      () => req.maskPngBase64 ?? this.viewport()?.maskCanvas()?.exportMaskPng() ?? undefined,
      () => this.viewport()?.maskCanvas()?.clear(),
    );
  }

  usePrompt(value: string): void {
    this.rail().updatePrompt(value);
  }

  /** Profile-menu "Buy credits" → Billing tab (packs live there). */
  topUp(): void {
    void this.router.navigate(['/app/settings'], { queryParams: { tab: 'billing' } });
  }

  /** First-load onboarding: only when the server-synced pref says unseen. */
  private maybeStartTour(): void {
    if (this.prefsService.prefs().tourSeen || this.notices.suspended()) return;
    // Let the first frame paint so data-tour targets have settled rects.
    requestAnimationFrame(() => requestAnimationFrame(() => this.tour.start()));
  }

  /** Replay from the profile menu. Tour targets only exist in library mode. */
  onStartTour(): void {
    if (this.mode() === 'edit') this.exitEdit();
    if (this.mode() !== 'library') return; // user kept unsaved edits
    this.tour.start();
  }

  async signOut(): Promise<void> {
    // Teardown lives in SessionLifecycle now, driven by the auth event, so it
    // also runs for an expiry or a sign-out performed in another tab. Doing
    // it here as well was the reason none of those cases cleaned up.
    await this.auth.signOut();
    this.router.navigate(['/']);
  }
}
