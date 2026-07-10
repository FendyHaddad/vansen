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
  lucideBrush,
  lucideCheck,
  lucideCrop,
  lucideEraser,
  lucideLock,
  lucideRedo2,
  lucideScan,
  lucideSlidersHorizontal,
  lucideSparkles,
  lucideUndo2,
  lucideWand,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { EDIT_TOOLS } from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
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
  { id: 'sharpen', label: 'Sharpen', icon: 'lucideWand' },
  { id: 'smooth', label: 'Smooth', icon: 'lucideWand' },
  { id: 'liquify', label: 'Liquify', icon: 'lucideScan' },
  { id: 'heal', label: 'Spot Heal', icon: 'lucideBrush' },
  { id: 'mask', label: 'Mask', icon: 'lucideEraser' },
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
      lucideBrush,
      lucideCheck,
      lucideCrop,
      lucideEraser,
      lucideLock,
      lucideRedo2,
      lucideScan,
      lucideSlidersHorizontal,
      lucideSparkles,
      lucideUndo2,
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
  readonly aiToolRequested = output<{ toolId: string; prompt: string }>();

  readonly localTools = LOCAL_TOOLS;
  readonly aiTools = EDIT_TOOLS;
  readonly studioActive = this.profileStore.studioActive;
  readonly balanceUsd = this.ledger.balanceUsd;

  /** Studio | Pro tier switch — Pro is a locked teaser in this phase. */
  readonly tier = signal<'studio' | 'pro'>('studio');
  readonly activeTool = signal<StudioTool | null>(null);
  /** Shared brush size for heal/liquify — the viewport reads it too. */
  readonly brushSize = signal(40);
  /** Prompt for Generative Fill. */
  readonly fillPrompt = signal('');

  readonly locked = computed(() => !this.studioActive());

  selectTool(id: StudioTool): void {
    this.activeTool.set(this.activeTool() === id ? null : id);
  }

  affordable(priceUsd: number): boolean {
    return this.balanceUsd() >= priceUsd;
  }

  runAiTool(toolId: string): void {
    const tool = this.aiTools.find((t) => t.id === toolId);
    if (!tool || !this.affordable(tool.userPriceUsd)) return;
    if (tool.needsPrompt && !this.fillPrompt().trim()) return;
    this.aiToolRequested.emit({ toolId, prompt: this.fillPrompt().trim() });
  }
}
