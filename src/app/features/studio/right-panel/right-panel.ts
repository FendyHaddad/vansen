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
  lucideFocus,
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
  LOCAL_TOOLS,
  PRO_TOOLS,
  toolLabels,
  toolsFor,
} from '../../../core/catalog/entitlements';
import { EditToolCatalog } from '../../../core/catalog/edit-tool-catalog';
import { ToastService } from '../../../core/feedback/toast-service';
import {
  EDIT_TOOLS,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  PLAN_PROMO_USD,
  PRO_EXTRA_CREDIT_PERCENT,
  type EditTool,
} from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { StudioTool } from '../studio-tool';
import { ToolOptions } from '../tool-options/tool-options';

interface PlanPitch {
  title: string;
  sub: string;
  perks: string[];
}

/** Lock-card copy per tier. Prices, credits and tool names all come from the
 * catalog, so this card, the plans page and the landing page cannot drift. */
const PLAN_PITCH: Record<'studio' | 'pro', PlanPitch> = {
  studio: {
    title: 'Studio Editing',
    sub: 'Unlock the full editing suite for every image you generate.',
    perks: [
      `${toolLabels(toolsFor('studio')).filter((l) => l !== 'Mask').slice(0, 4).join(', ')} and more — free`,
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
      `${toolLabels(toolsFor('pro')).join(', ')} — free`,
      'Video models — Pro only',
      `${PLAN_CREDITS.pro.toLocaleString()} credits every month — ${PRO_EXTRA_CREDIT_PERCENT}% more per dollar`,
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
      lucideFocus,
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
  private readonly editToolCatalog = inject(EditToolCatalog);
  private readonly toast = inject(ToastService);

  /** True while the workspace is in edit mode (panel is a teaser otherwise). */
  readonly editing = input(false);
  /** The library already has images, so the "open or upload" hint says nothing new. */
  readonly hasImages = input(false);

  /** True while the workspace is redirecting to Stripe — drives the CTA spinner. */
  readonly checkoutBusy = input(false);

  readonly saveRequested = output<void>();
  readonly subscribeRequested = output<'studio' | 'pro'>();
  /** Existing subscribers change plan in the Stripe portal — /billing/subscribe
   * rejects them with `already_subscribed`, so an upgrade must not go there. */
  readonly upgradeRequested = output<void>();
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

  /** The subscribe pitch sells Studio; Pro is reached by upgrading from inside. */
  readonly pitch = computed(() => PLAN_PITCH.studio);
  readonly planPriceUsd = computed(() => PLAN_PRICE_USD.studio);
  readonly planPromoUsd = computed(() => PLAN_PROMO_USD.studio);
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

  /** Until /profile AND the AI edit tools' served plans answer, the rail shows
   * a spinner — rendering either branch early flashes the wrong one at
   * somebody (tools at visitors, an unlocked AI tool that is actually pro-only,
   * or the subscribe pitch at subscribers whose cache was cleared). */
  readonly ready = computed(() => this.profileStore.loaded() && this.editToolCatalog.loaded());

  readonly locked = computed(() => this.profileStore.loaded() && !this.studioActive());

  /** Pro tools lock: pro/owner subscribers only. Waits for /profile like `locked`.
   * This still covers the local Pro-preview tools (ENTITLEMENTS) — every one of
   * them is pro-tier by definition. */
  readonly proLocked = computed(() => this.profileStore.loaded() && !this.profileStore.proActive());

  /** Whether any AI edit tool is out of reach on the visitor's current plan —
   * drives the "AI Tools" section note. Each tool's own floor comes from the
   * server (`flat.editTools[].plan`), not a blanket "AI tools are Pro" rule. */
  readonly anyAiToolLocked = computed(() => this.aiTools.some((tool) => this.aiToolLocked(tool)));

  /** True once at least one AI edit tool is unlocked — the "not enough
   * credits" hint is only useful while there is something to spend them on. */
  readonly anyAiToolUnlocked = computed(() => this.aiTools.some((tool) => !this.aiToolLocked(tool)));

  /** A plan change already booked for renewal — the standing reminder. */
  readonly pendingPlan = computed(() => this.profileStore.subscription()?.pendingPlan ?? null);
  readonly pendingAt = computed(() => this.profileStore.subscription()?.pendingAt ?? null);
  readonly pendingLabel = computed(() => (this.pendingPlan() === 'pro' ? 'Pro' : 'Studio'));

  /** Show the plan pitch instead of the tool rail. */
  readonly showPitch = this.locked;

  /** The launch coupon is first-time-only (`firstTime` in /billing/subscribe keys
   * off ever having had a Stripe subscription). Anyone with a subscription row —
   * lapsed included — will not get it, so never promise it to them. */
  readonly showPromo = computed(() => this.profileStore.subscription() === null);

  readonly ctaLabel = computed(() => `Subscribe to Studio · $${this.planPriceUsd()}/mo`);

  /** A locked Pro tool is an upgrade prompt, not a dead button. */
  pickProTool(id: StudioTool): void {
    if (this.proLocked()) {
      this.upgradeRequested.emit();
      return;
    }
    this.selectTool(id);
  }

  selectTool(id: StudioTool): void {
    this.activeTool.set(this.activeTool() === id ? null : id);
  }

  affordable(priceCredits: number): boolean {
    return this.totalCredits() >= priceCredits;
  }

  /** The plan this AI edit tool actually needs, per the server's `models.min_plan`. */
  aiToolPlan(tool: EditTool): 'studio' | 'pro' {
    return this.editToolCatalog.planFor(tool.id);
  }

  /** This panel only renders the AI tools once the visitor is studioActive
   * (`showPitch` covers everyone below that), so a studio-plan tool is never
   * locked here — only a pro-plan tool can be, for a non-pro subscriber. */
  aiToolLocked(tool: EditTool): boolean {
    return this.aiToolPlan(tool) === 'pro' && !this.profileStore.proActive();
  }

  /** Names the plan the tool actually needs, so the copy matches whatever
   * `min_plan` the server has configured instead of always saying "Pro". */
  aiToolLockTitle(tool: EditTool): string {
    const planLabel = this.aiToolPlan(tool) === 'pro' ? 'Pro' : 'Studio';
    return `${planLabel} tool — upgrade to unlock`;
  }

  /** Client-side download of the current canvas in the chosen format. */
  async exportAs(format: ExportFormat): Promise<void> {
    this.exportOpen.set(false);
    let blob: Blob;
    try {
      blob = await this.session.exportBlob(format.type, format.quality);
    } catch {
      this.toast.error('Export failed');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vansen-${this.session.item()?.id ?? 'edit'}.${format.ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.toast.success(`Exported as ${format.ext.toUpperCase()}`);
  }

  runAiTool(toolId: string): void {
    const tool = this.aiTools.find((t) => t.id === toolId);
    if (!tool || this.aiToolLocked(tool) || !this.affordable(tool.creditCost)) return;
    if (tool.needsPrompt && !this.fillPrompt().trim()) return;
    this.aiToolRequested.emit({ toolId, prompt: this.fillPrompt().trim() });
  }

  /** AI edit scoped to an Ai Select mask — priced like the mask-painted flow. */
  onAiSelection(req: { toolId: string; prompt: string; maskPngBase64: string }): void {
    const tool = this.aiTools.find((t) => t.id === req.toolId);
    if (!tool || this.aiToolLocked(tool) || !this.affordable(tool.creditCost)) return;
    this.aiToolRequested.emit(req);
  }
}
