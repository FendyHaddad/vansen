import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAperture,
  lucideBrush,
  lucideCalendarClock,
  lucideChartNoAxesColumn,
  lucideCheck,
  lucideCloudFog,
  lucideCrop,
  lucideDownload,
  lucideEclipse,
  lucideEraser,
  lucideImageOff,
  lucideLock,
  lucideMaximize2,
  lucideMousePointerClick,
  lucideMove3d,
  lucidePalette,
  lucideSave,
  lucideScan,
  lucideSlidersHorizontal,
  lucideSmile,
  lucideSparkles,
  lucideStamp,
  lucideSun,
  lucideWand,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import {
  EDIT_TOOLS,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  PLAN_PROMO_USD,
} from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { StudioTool } from '../studio-tool';
import { ToolOptions } from '../tool-options/tool-options';

interface LocalToolDef {
  id: StudioTool;
  label: string;
  icon: string;
}

const LOCAL_TOOLS: LocalToolDef[] = [
  { id: 'crop', label: 'Crop', icon: 'lucideCrop' },
  { id: 'adjust', label: 'Adjust', icon: 'lucideSlidersHorizontal' },
  { id: 'filters', label: 'Filters', icon: 'lucidePalette' },
  { id: 'sharpen', label: 'Sharpen', icon: 'lucideWand' },
  { id: 'smooth', label: 'Smooth', icon: 'lucideWand' },
  { id: 'heal', label: 'Spot Heal', icon: 'lucideBrush' },
  { id: 'dehaze', label: 'Dehaze', icon: 'lucideCloudFog' },
  { id: 'portraitsmooth', label: 'Portrait Smooth', icon: 'lucideSmile' },
];

/** Pro-tier locals — pro/owner subscribers only (see `proLocked`). */
const PRO_TOOLS: LocalToolDef[] = [
  { id: 'select', label: 'Ai Select', icon: 'lucideMousePointerClick' },
  { id: 'upscale', label: 'Ai Upscale', icon: 'lucideMaximize2' },
  { id: 'bgremove', label: 'Cut Out', icon: 'lucideImageOff' },
  { id: 'bokeh', label: 'Bokeh', icon: 'lucideAperture' },
  { id: 'enhance', label: 'Enhance', icon: 'lucideSun' },
  { id: 'levels', label: 'Levels', icon: 'lucideChartNoAxesColumn' },
  { id: 'clone', label: 'Clone', icon: 'lucideStamp' },
  { id: 'retouch', label: 'Retouch', icon: 'lucideEclipse' },
  { id: 'perspective', label: 'Perspective', icon: 'lucideMove3d' },
  { id: 'liquify', label: 'Liquify', icon: 'lucideScan' },
  { id: 'erase', label: 'Magic Erase', icon: 'lucideEraser' },
];

interface PlanPitch {
  title: string;
  sub: string;
  perks: string[];
}

/** Lock-card copy per tier. Prices/credits come from the catalog so this card,
 * the plans page and the pricing page can never drift apart. */
const PLAN_PITCH: Record<'studio' | 'pro', PlanPitch> = {
  studio: {
    title: 'Studio Editing',
    sub: 'Unlock the full editing suite for every image you generate.',
    perks: [
      'Crop, adjust, filters, heal — free',
      'AI remove, fill & expand from 5 credits',
      `${PLAN_CREDITS.studio.toLocaleString()} credits included every month`,
      'Every edit saved as a new version',
    ],
  },
  pro: {
    title: 'Vansen Pro',
    sub: 'Everything in Studio, plus the Pro tools and video generation.',
    perks: [
      'Everything in Studio',
      'Cut Out, Bokeh, Upscale, Magic Erase — free',
      'Video models — Pro only',
      `${PLAN_CREDITS.pro.toLocaleString()} credits every month — 25% more per dollar`,
    ],
  },
};

interface ExportFormat {
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  label: string;
  hint: string;
  ext: string;
  quality?: number;
}

const EXPORT_FORMATS: ExportFormat[] = [
  { type: 'image/png', label: 'PNG', hint: 'Lossless, largest file', ext: 'png' },
  { type: 'image/jpeg', label: 'JPG', hint: 'Small file, best for photos', ext: 'jpg', quality: 0.92 },
  { type: 'image/webp', label: 'WebP', hint: 'Modern, small + sharp', ext: 'webp', quality: 0.92 },
];

/** Right rail: free local tools on top, priced AI tools below, Studio-gated. */
@Component({
  selector: 'app-right-panel',
  templateUrl: './right-panel.html',
  styleUrl: './right-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgIcon, HlmButton, ToolOptions],
  providers: [
    provideIcons({
      lucideAperture,
      lucideBrush,
      lucideCalendarClock,
      lucideChartNoAxesColumn,
      lucideCheck,
      lucideCloudFog,
      lucideCrop,
      lucideDownload,
      lucideEclipse,
      lucideEraser,
      lucideImageOff,
      lucideLock,
      lucideMaximize2,
      lucideMousePointerClick,
      lucideMove3d,
      lucidePalette,
      lucideSave,
      lucideScan,
      lucideSlidersHorizontal,
      lucideSmile,
      lucideSparkles,
      lucideStamp,
      lucideSun,
      lucideWand,
    }),
  ],
})
export class RightPanel {
  readonly session = inject(EditSession);
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);

  /** True while the workspace is in edit mode (panel is a teaser otherwise). */
  readonly editing = input(false);

  /** True while the workspace is redirecting to Stripe — drives the CTA spinner. */
  readonly checkoutBusy = input(false);

  readonly saveRequested = output<void>();
  /** Emits the plan the visitor picked in the tier switch, not just "studio". */
  readonly subscribeRequested = output<'studio' | 'pro'>();
  /** Existing subscribers change plan in the Stripe portal — /billing/subscribe
   * rejects them with `already_subscribed`, so an upgrade must not go there. */
  readonly upgradeRequested = output<void>();
  /** Pro → Studio, via the same confirm dialog (period-end only, server-enforced). */
  readonly downgradeRequested = output<void>();
  readonly aiToolRequested = output<{
    toolId: string;
    prompt: string;
    maskPngBase64?: string;
  }>();

  readonly localTools = LOCAL_TOOLS;
  readonly proTools = PRO_TOOLS;
  readonly aiTools = EDIT_TOOLS;
  readonly studioActive = this.profileStore.studioActive;
  readonly totalCredits = this.ledger.totalCredits;

  /** Studio | Pro tier switch — drives the lock card and which plan gets bought. */
  readonly tier = signal<'studio' | 'pro'>('studio');
  readonly pitch = computed(() => PLAN_PITCH[this.tier()]);
  readonly planPriceUsd = computed(() => PLAN_PRICE_USD[this.tier()]);
  readonly planPromoUsd = computed(() => PLAN_PROMO_USD[this.tier()]);
  readonly planLabel = computed(() => (this.tier() === 'pro' ? 'Pro' : 'Studio'));
  readonly activeTool = signal<StudioTool | null>(null);
  /** Shared brush size for heal/liquify/mask — the viewport reads it too. */
  readonly brushSize = signal(40);
  /** Locked crop ratio (w/h) picked in tool options; the viewport reads it. */
  readonly cropAspect = signal<number | null>(null);
  /** Liquify brush behavior — the viewport reads both. */
  readonly liquifyMode = signal<LiquifyMode>('push');
  readonly liquifyStrength = signal(50);
  /** Dodge/burn brush behavior — the viewport reads all three. */
  readonly retouchMode = signal<RetouchMode>('lighten');
  readonly retouchStrength = signal(50);
  readonly retouchFeather = signal(50);
  /** Clone-stamp dab opacity — the viewport reads it. */
  readonly cloneStrength = signal(100);
  /** Prompt for Generative Fill. */
  readonly fillPrompt = signal('');
  /** Export format picker visibility. */
  readonly exportOpen = signal(false);
  readonly exportFormats = EXPORT_FORMATS;

  /** Until /profile answers, the rail shows a spinner — rendering either branch
   * early flashes the wrong one at somebody (tools at visitors, or the subscribe
   * pitch at subscribers whose cache was cleared). */
  readonly ready = this.profileStore.loaded;

  readonly locked = computed(() => this.profileStore.loaded() && !this.studioActive());

  /** Pro tools lock: pro/owner subscribers only. Waits for /profile like `locked`. */
  readonly proLocked = computed(() => this.profileStore.loaded() && !this.profileStore.proActive());

  /** A Studio subscriber who switched to the Pro tab: sell the upgrade rather
   * than the tools they already have. */
  readonly upgrading = computed(() => !this.locked() && this.tier() === 'pro' && this.proLocked());

  /** A plan change already booked for renewal — the standing reminder. */
  readonly pendingPlan = computed(() => this.profileStore.subscription()?.pendingPlan ?? null);
  readonly pendingAt = computed(() => this.profileStore.subscription()?.pendingAt ?? null);
  readonly pendingLabel = computed(() => (this.pendingPlan() === 'pro' ? 'Pro' : 'Studio'));

  /** Show the plan pitch instead of the tool rail. */
  readonly showPitch = computed(() => this.locked() || this.upgrading());

  /** A Pro subscriber browsing the Studio tab: they own every tool shown, so the
   * rail stays — a compact downgrade offer rides above it instead. Hidden once
   * the downgrade is booked (the pending note already covers that state). */
  readonly downgradeOffer = computed(
    () =>
      !this.locked() &&
      this.tier() === 'studio' &&
      this.profileStore.subscription()?.plan === 'pro' &&
      this.pendingPlan() !== 'studio',
  );

  /** The launch coupon is first-time-only (`firstTime` in /billing/subscribe keys
   * off ever having had a Stripe subscription). Anyone with a subscription row —
   * lapsed included — will not get it, so never promise it to them. */
  readonly showPromo = computed(() => this.profileStore.subscription() === null);

  readonly ctaLabel = computed(() =>
    this.upgrading()
      ? `Upgrade to Pro · $${PLAN_PRICE_USD.pro}/mo`
      : `Subscribe to ${this.planLabel()} · $${this.planPriceUsd()}/mo`,
  );

  selectTool(id: StudioTool): void {
    this.activeTool.set(this.activeTool() === id ? null : id);
  }

  affordable(priceCredits: number): boolean {
    return this.totalCredits() >= priceCredits;
  }

  /** Client-side download of the current canvas in the chosen format. */
  async exportAs(format: ExportFormat): Promise<void> {
    this.exportOpen.set(false);
    const blob = await this.session.exportBlob(format.type, format.quality);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vansen-${this.session.item()?.id ?? 'edit'}.${format.ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  runAiTool(toolId: string): void {
    if (this.proLocked()) return;
    const tool = this.aiTools.find((t) => t.id === toolId);
    if (!tool || !this.affordable(tool.creditCost)) return;
    if (tool.needsPrompt && !this.fillPrompt().trim()) return;
    this.aiToolRequested.emit({ toolId, prompt: this.fillPrompt().trim() });
  }

  /** AI edit scoped to an Ai Select mask — priced like the mask-painted flow. */
  onAiSelection(req: { toolId: string; prompt: string; maskPngBase64: string }): void {
    if (this.proLocked()) return;
    const tool = this.aiTools.find((t) => t.id === req.toolId);
    if (!tool || !this.affordable(tool.creditCost)) return;
    this.aiToolRequested.emit(req);
  }
}
