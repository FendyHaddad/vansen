// Parameter strip for the active local tool (brush size, amounts, apply).
// Stable entry point other files bind to (selector, inputs/outputs); state
// and behaviour split into PreviewOpsController (live-preview pipeline) and
// EngineToolsController (on-device ONNX / selection-driven tools). Tool-
// switch reset, histogram redraw and canvas-click routing stay here.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  model,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { StudioTool } from '../studio-tool';
import {
  CROP_PRESETS,
  FILTER_PRESETS,
  LIQUIFY_MODES,
  RETOUCH_MODES,
  toNum as clampNumber,
} from './tool-options.constants';
import { AiSelectionRequest, EngineToolsController } from './tool-options-engine-tools';
import { PreviewOpsController } from './tool-options-preview-ops';

@Component({
  selector: 'app-tool-options',
  templateUrl: './tool-options.html',
  styleUrl: './tool-options.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolOptions {
  readonly session = inject(EditSession);
  readonly tool = input<StudioTool | null>(null);
  /** Shared with the viewport — heal/liquify/mask/clone/retouch brushes read the same size. */
  readonly brushSize = model(40);
  /** Shared with the viewport — locked crop ratio, null = free. */
  readonly cropAspect = model<number | null>(null);
  readonly liquifyMode = model<LiquifyMode>('push');
  /** 0..100, scales liquify displacement. */
  readonly liquifyStrength = model(50);
  /** Shared with the viewport — dodge/burn brush behavior. */
  readonly retouchMode = model<RetouchMode>('lighten');
  readonly retouchStrength = model(50);
  /** 0..100 edge softness for the retouch brush. */
  readonly retouchFeather = model(50);
  /** 0..100 clone-stamp dab opacity. */
  readonly cloneStrength = model(100);

  readonly cropPresets = CROP_PRESETS;
  readonly liquifyModes = LIQUIFY_MODES;
  readonly filterPresets = FILTER_PRESETS;
  readonly retouchModes = RETOUCH_MODES;

  /** AI edit scoped to the selection mask — the workspace runs the job. */
  readonly aiSelection = output<AiSelectionRequest>();

  /** Tools driven by the session's live-preview pipeline (adjust, crop,
   * filters, levels, perspective, …). */
  readonly ops = new PreviewOpsController(this.session, () => this.tool(), this.cropAspect);
  /** On-device (ONNX) and selection-driven tools (cutout, upscale, bokeh,
   * smart select, magic erase). */
  readonly engineTools = new EngineToolsController(this.session, () => this.tool(), (payload) =>
    this.aiSelection.emit(payload),
  );

  /** Clamp a free-typed number from a percent/degree input box. */
  readonly toNum = clampNumber;

  private readonly histCanvas = viewChild<ElementRef<HTMLCanvasElement>>('histCanvas');

  constructor() {
    // Switching tools drops any un-applied preview and resets the sliders.
    // Enhance and Filters preview immediately — the user should see the
    // effect the moment the tool opens, not after hunting for a slider.
    effect(() => {
      const t = this.tool();
      untracked(() => {
        this.resetPending();
        if (t === 'enhance' || t === 'filters' || t === 'dehaze' || t === 'portraitsmooth') {
          this.schedulePreview();
        }
      });
    });
    // Histogram behind the Levels sliders — redrawn after every commit AND
    // after every slider preview, so the bars move with the values. The
    // viewChild read must stay tracked: the canvas mounts AFTER the tool
    // switch renders the @case, and only its signal flipping re-runs this.
    effect(() => {
      if (this.tool() !== 'levels') return;
      if (!this.histCanvas()) return;
      this.session.previewUrl();
      this.session.previewBuffer();
      untracked(() => this.ops.drawHistogram(this.histCanvas()?.nativeElement));
    });
    // Canvas clicks routed from the viewport: bokeh re-focuses, select masks.
    effect(() => {
      const pick = this.session.pointPick();
      if (!pick) return;
      const t = untracked(() => this.tool());
      untracked(() => {
        if (t === 'bokeh') {
          this.engineTools.bokehFocus.set(pick);
          this.engineTools.scheduleBokehPreview();
        } else if (t === 'select') {
          // First click is always additive — subtracting from nothing is a no-op.
          this.engineTools.addSelectPoint(pick);
          void this.engineTools.runSelect();
        } else if (t === 'erase') {
          void this.engineTools.runErase({ x: pick.x, y: pick.y, label: 1 });
        }
      });
    });
    // Deselecting a tool destroys this strip (right-panel @if). An un-applied
    // slider/filter preview would otherwise linger on the canvas with no owner
    // to clear it — drop it so closing a tool discards its preview.
    inject(DestroyRef).onDestroy(() => {
      this.ops.cancelPreview();
      this.engineTools.cancelBokehPreview();
      this.session.resetPreview();
      this.session.setPointPick(null);
    });
  }

  /** Live preview, coalesced to one compute per frame — no history commit. */
  schedulePreview(): void {
    this.ops.schedulePreview();
  }

  private resetPending(): void {
    this.ops.reset();
    this.engineTools.reset();
    this.session.setPointPick(null);
    this.session.resetPreview();
  }
}
