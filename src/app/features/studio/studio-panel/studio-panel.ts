import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAperture,
  lucideBrush,
  lucideChartNoAxesColumn,
  lucideCheck,
  lucideCrop,
  lucideDownload,
  lucideEclipse,
  lucideImageOff,
  lucideLock,
  lucideMaximize2,
  lucideMousePointerClick,
  lucideMove3d,
  lucidePalette,
  lucideSave,
  lucideScan,
  lucideSlidersHorizontal,
  lucideSparkles,
  lucideStamp,
  lucideSun,
  lucideWand,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { EDIT_TOOLS } from '../../../core/catalog/model-families';
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
];

/** Pro-tier locals — unlocked for everyone while they're being test-driven;
 * the lock pass happens once they graduate. */
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
];

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
  selector: 'app-studio-panel',
  templateUrl: './studio-panel.html',
  styleUrl: './studio-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgIcon, HlmButton, ToolOptions],
  providers: [
    provideIcons({
      lucideAperture,
      lucideBrush,
      lucideChartNoAxesColumn,
      lucideCheck,
      lucideCrop,
      lucideDownload,
      lucideEclipse,
      lucideImageOff,
      lucideLock,
      lucideMaximize2,
      lucideMousePointerClick,
      lucideMove3d,
      lucidePalette,
      lucideSave,
      lucideScan,
      lucideSlidersHorizontal,
      lucideSparkles,
      lucideStamp,
      lucideSun,
      lucideWand,
    }),
  ],
})
export class StudioPanel {
  readonly session = inject(EditSession);
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);

  /** True while the workspace is in edit mode (panel is a teaser otherwise). */
  readonly editing = input(false);

  readonly saveRequested = output<void>();
  readonly subscribeRequested = output<void>();
  readonly aiToolRequested = output<{
    toolId: string;
    prompt: string;
    maskPngBase64?: string;
  }>();

  readonly localTools = LOCAL_TOOLS;
  readonly proTools = PRO_TOOLS;
  readonly aiTools = EDIT_TOOLS;
  readonly studioActive = this.profileStore.studioActive;
  readonly balanceUsd = this.ledger.balanceUsd;

  /** Studio | Pro tier switch — Pro is a locked teaser in this phase. */
  readonly tier = signal<'studio' | 'pro'>('studio');
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

  /** Only lock once the profile actually loaded — an in-flight /profile must
   * not flash the "subscribe" overlay at subscribed users. */
  readonly locked = computed(() => this.profileStore.loaded() && !this.studioActive());

  /** Pro tools are unlocked for everyone while testing. When Studio goes live
   * this flips true for non-Pro subscribers so the tiles disable + show a lock;
   * flip to a profile-driven check at that point. */
  readonly proLocked = signal(false);

  selectTool(id: StudioTool): void {
    this.activeTool.set(this.activeTool() === id ? null : id);
  }

  affordable(priceUsd: number): boolean {
    return this.balanceUsd() >= priceUsd;
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
    const tool = this.aiTools.find((t) => t.id === toolId);
    if (!tool || !this.affordable(tool.userPriceUsd)) return;
    if (tool.needsPrompt && !this.fillPrompt().trim()) return;
    this.aiToolRequested.emit({ toolId, prompt: this.fillPrompt().trim() });
  }

  /** AI edit scoped to an Ai Select mask — priced like the mask-painted flow. */
  onAiSelection(req: { toolId: string; prompt: string; maskPngBase64: string }): void {
    const tool = this.aiTools.find((t) => t.id === req.toolId);
    if (!tool || !this.affordable(tool.userPriceUsd)) return;
    this.aiToolRequested.emit(req);
  }
}
