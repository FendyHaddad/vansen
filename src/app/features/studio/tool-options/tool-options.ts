import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { EDIT_TOOLS } from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
import { MAX_UPSCALE_PIXELS } from '../../../core/editing/engines/engine-status';
// Type-only: a value import would drag onnxruntime into the eager bundle.
import type { SelectPoint } from '../../../core/editing/engines/select-engine';
import {
  cutoutModelProgress,
  depthModelProgress,
  samModelProgress,
  upscaleModelProgress,
  upscaleTileProgress,
} from '../../../core/editing/engines/engine-status';
import { healModelProgress } from '../../../core/editing/heal-status';
import { PixelBuffer } from '../../../core/editing/pixel-buffer';
import { FilterPreset } from '../../../core/editing/ops/filters';
import { lumaHistogram } from '../../../core/editing/ops/levels';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { FlipAxis } from '../../../core/editing/ops/transform';
import { StudioTool } from '../studio-tool';

interface CropPreset {
  label: string;
  /** Width / height; null = free-form. */
  value: number | null;
}

const CROP_PRESETS: CropPreset[] = [
  { label: 'Free', value: null },
  { label: 'Square 1:1', value: 1 },
  { label: 'Post 4:5', value: 4 / 5 },
  { label: 'Story 9:16', value: 9 / 16 },
  { label: 'Desktop 16:9', value: 16 / 9 },
  { label: 'Photo 3:2', value: 3 / 2 },
];

const LIQUIFY_MODES: { id: LiquifyMode; label: string; blurb: string }[] = [
  { id: 'push', label: 'Push', blurb: 'Drag pixels along your stroke' },
  { id: 'pinch', label: 'Slim', blurb: 'Shrink toward the brush center' },
  { id: 'bulge', label: 'Bulge', blurb: 'Expand from the brush center' },
];

const FILTER_PRESETS: { id: FilterPreset; label: string }[] = [
  { id: 'bw', label: 'B&W' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'grain', label: 'Film Grain' },
  { id: 'vignette', label: 'Vignette' },
];

/** Geometry sliders (straighten, perspective) preview on a copy no larger
 * than this — the overlay canvas CSS-scales it back over the image. */
const PREVIEW_MAX_DIM = 1100;

const RETOUCH_MODES: { id: RetouchMode; label: string; blurb: string }[] = [
  { id: 'lighten', label: 'Lighten', blurb: 'Brighten where you paint (dodge)' },
  { id: 'darken', label: 'Darken', blurb: 'Deepen shadows where you paint (burn)' },
  { id: 'saturate', label: 'Saturate', blurb: 'Boost color where you paint' },
  { id: 'desaturate', label: 'Mute', blurb: 'Drain color where you paint' },
];

/** Parameter strip for the active local tool (brush size, amounts, apply). */
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
  /** MI-GAN model download %, first heal only — null when idle. */
  readonly healPct = computed(() => {
    const p = healModelProgress();
    return p === null ? null : Math.round(p * 100);
  });
  readonly brightness = signal(0);
  readonly contrast = signal(0);
  readonly saturation = signal(0);
  readonly amount = signal(50);
  /** −45..45°, live-previews without crop; Apply crops to the inside rect. */
  readonly straightenDeg = signal(0);
  readonly filterPreset = signal<FilterPreset>('bw');
  readonly filterIntensity = signal(80);
  readonly enhanceStrength = signal(80);
  readonly levelsBlack = signal(0);
  readonly levelsWhite = signal(255);
  /** Stored ×100 so the range input stays integer (20..300 → 0.2..3.0). */
  readonly levelsGamma = signal(100);
  readonly perspV = signal(0);
  readonly perspH = signal(0);
  readonly bokehStrength = signal(50);
  /** Focus point in image px; null = center until the user clicks. */
  readonly bokehFocus = signal<{ x: number; y: number } | null>(null);
  /** Smart-select mask for the clicked object, null = nothing selected. */
  readonly selMask = signal<Uint8Array | null>(null);
  /** All selection clicks so far — SAM refines the mask from the full set. */
  readonly selPoints = signal<SelectPoint[]>([]);
  /** Whether the next click grows or carves the selection. */
  readonly selMode = signal<'add' | 'subtract'>('add');
  /** Prompt for AI Fill on the selected area. */
  readonly selPrompt = signal('');
  /** AI edit scoped to the selection mask — the workspace runs the job. */
  readonly aiSelection = output<{ toolId: string; prompt: string; maskPngBase64: string }>();
  /** Retail prices for the AI-on-selection buttons, pre-formatted. */
  readonly aiRemovePrice = (
    EDIT_TOOLS.find((t) => t.id === 'edit-remove')?.userPriceUsd ?? 0
  ).toFixed(2);
  readonly aiFillPrice = (EDIT_TOOLS.find((t) => t.id === 'edit-fill')?.userPriceUsd ?? 0).toFixed(
    2,
  );
  /** True while an engine (ONNX) call runs from this strip. */
  readonly engineBusy = signal(false);
  readonly engineError = signal('');

  /** First-use model download % for whichever engine tool is open. */
  readonly enginePct = computed(() => {
    const p =
      cutoutModelProgress() ??
      depthModelProgress() ??
      upscaleModelProgress() ??
      samModelProgress();
    return p === null ? null : Math.round(p * 100);
  });
  /** Upscale inference progress %, null when idle. */
  readonly upscalePct = computed(() => {
    const p = upscaleTileProgress();
    return p === null ? null : Math.round(p * 100);
  });
  /** Current pixel size — refreshed on every commit for the upscale caption. */
  readonly imageSize = computed(() => {
    this.session.previewUrl();
    const buf = this.session.current();
    return buf ? { w: buf.width, h: buf.height } : null;
  });
  readonly upscaleTooLarge = computed(() => {
    const s = this.imageSize();
    return !!s && s.w * s.h > MAX_UPSCALE_PIXELS;
  });

  private bokehToken = 0;

  private readonly histCanvas = viewChild<ElementRef<HTMLCanvasElement>>('histCanvas');

  private previewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Switching tools drops any un-applied preview and resets the sliders.
    // Enhance and Filters preview immediately — the user should see the
    // effect the moment the tool opens, not after hunting for a slider.
    effect(() => {
      const t = this.tool();
      untracked(() => {
        this.resetPending();
        if (t === 'enhance' || t === 'filters') this.schedulePreview();
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
      untracked(() => this.drawHistogram());
    });
    // Canvas clicks routed from the viewport: bokeh re-focuses, select masks.
    effect(() => {
      const pick = this.session.pointPick();
      if (!pick) return;
      const t = untracked(() => this.tool());
      untracked(() => {
        if (t === 'bokeh') {
          this.bokehFocus.set(pick);
          this.scheduleBokehPreview();
        } else if (t === 'select') {
          // First click is always additive — subtracting from nothing is a no-op.
          const label: 0 | 1 =
            this.selPoints().length && this.selMode() === 'subtract' ? 0 : 1;
          this.selPoints.update((pts) => [...pts, { x: pick.x, y: pick.y, label }]);
          void this.runSelect();
        }
      });
    });
  }

  /** Clamp free-typed numbers from the percent boxes. */
  toNum(value: string, lo: number, hi: number): number {
    const n = Number(value);
    if (Number.isNaN(n)) return 0;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  /** Debounced live preview — renders without committing to history. */
  schedulePreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.runPreview(), 80);
  }

  private async runPreview(): Promise<void> {
    const t = this.tool();
    if (t === 'adjust') {
      await this.session.previewOp('adjust', {
        brightness: this.brightness(),
        contrast: this.contrast(),
        saturation: this.saturation(),
      });
    } else if (t === 'sharpen') {
      await this.session.previewOp('sharpen', this.amount());
    } else if (t === 'smooth') {
      await this.session.previewOp('smooth', this.amount());
    } else if (t === 'crop') {
      // Rotate/flip/straighten live inside the crop options.
      if (this.straightenDeg() === 0) this.session.resetPreview();
      else
        await this.session.previewOp(
          'straighten',
          { degrees: this.straightenDeg(), crop: false },
          PREVIEW_MAX_DIM,
        );
    } else if (t === 'filters') {
      await this.session.previewOp('filter', {
        preset: this.filterPreset(),
        intensity: this.filterIntensity(),
      });
    } else if (t === 'enhance') {
      await this.session.previewOp('enhance', this.enhanceStrength());
    } else if (t === 'levels') {
      await this.session.previewOp('levels', this.levelsParams());
    } else if (t === 'perspective') {
      if (this.perspV() === 0 && this.perspH() === 0) this.session.resetPreview();
      else
        await this.session.previewOp(
          'perspective',
          { vertical: this.perspV(), horizontal: this.perspH() },
          PREVIEW_MAX_DIM,
        );
    }
  }

  private resetPending(): void {
    clearTimeout(this.previewTimer);
    this.brightness.set(0);
    this.contrast.set(0);
    this.saturation.set(0);
    this.amount.set(50); // sharpen/smooth must not inherit each other's value
    this.straightenDeg.set(0);
    this.filterPreset.set('bw');
    this.filterIntensity.set(80);
    this.enhanceStrength.set(80);
    this.levelsBlack.set(0);
    this.levelsWhite.set(255);
    this.levelsGamma.set(100);
    this.perspV.set(0);
    this.perspH.set(0);
    this.bokehStrength.set(50);
    this.bokehFocus.set(null);
    this.selMask.set(null);
    this.selPoints.set([]);
    this.selMode.set('add');
    this.selPrompt.set('');
    this.engineError.set('');
    this.session.setPointPick(null);
    this.session.resetPreview();
  }

  selectPreset(value: number | null): void {
    this.cropAspect.set(value);
  }

  /** Lock the crop to the image's own ratio. */
  selectOriginal(): void {
    const buf = this.session.current();
    if (buf) this.cropAspect.set(buf.width / buf.height);
  }

  selectFilter(preset: FilterPreset): void {
    this.filterPreset.set(preset);
    this.schedulePreview();
  }

  async applyAdjust(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('adjust', {
      brightness: this.brightness(),
      contrast: this.contrast(),
      saturation: this.saturation(),
    });
    this.brightness.set(0);
    this.contrast.set(0);
    this.saturation.set(0);
  }

  async applySharpen(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('sharpen', this.amount());
  }

  async applySmooth(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('smooth', this.amount());
  }

  async applyRotate(): Promise<void> {
    await this.session.apply('rotate90', null);
  }

  async applyRotateCcw(): Promise<void> {
    await this.session.apply('rotate90ccw', null);
  }

  async applyFlip(axis: FlipAxis): Promise<void> {
    await this.session.apply('flip', axis);
  }

  async applyStraighten(): Promise<void> {
    clearTimeout(this.previewTimer);
    const degrees = this.straightenDeg();
    if (degrees === 0) return;
    await this.session.apply('straighten', { degrees, crop: true });
    this.straightenDeg.set(0);
  }

  async applyFilter(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('filter', {
      preset: this.filterPreset(),
      intensity: this.filterIntensity(),
    });
  }

  async applyEnhance(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('enhance', this.enhanceStrength());
  }

  async applyLevels(): Promise<void> {
    clearTimeout(this.previewTimer);
    await this.session.apply('levels', this.levelsParams());
    this.levelsBlack.set(0);
    this.levelsWhite.set(255);
    this.levelsGamma.set(100);
  }

  async applyPerspective(): Promise<void> {
    clearTimeout(this.previewTimer);
    if (this.perspV() === 0 && this.perspH() === 0) return;
    await this.session.apply('perspective', {
      vertical: this.perspV(),
      horizontal: this.perspH(),
    });
    this.perspV.set(0);
    this.perspH.set(0);
  }

  /** Cut Out: strip the background locally — free, on-device. */
  async runCutout(): Promise<void> {
    await this.runEngine(async () => {
      const { removeBackground } = await import('../../../core/editing/engines/cutout-engine');
      await this.session.applyEngine(removeBackground);
    });
  }

  /** Upscale 2×: tiled Swin2SR, on-device. */
  async runUpscale(): Promise<void> {
    await this.runEngine(async () => {
      const { upscale2x } = await import('../../../core/editing/engines/upscale-engine');
      await this.session.applyEngine(upscale2x);
    });
  }

  scheduleBokehPreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.runBokehPreview(), 150);
  }

  private async runBokehPreview(): Promise<void> {
    const token = ++this.bokehToken;
    const buf = this.session.current();
    if (!buf) return;
    this.engineError.set('');
    this.engineBusy.set(true);
    try {
      const { bokeh } = await import('../../../core/editing/engines/bokeh-engine');
      const out = await bokeh(buf, {
        focus: this.bokehFocus(),
        strength: this.bokehStrength(),
      });
      if (token === this.bokehToken && this.tool() === 'bokeh') {
        this.session.showPreviewBuffer(out);
      }
    } catch {
      if (token === this.bokehToken) this.engineError.set('Engine failed to load — check your connection and try again.');
    } finally {
      if (token === this.bokehToken) this.engineBusy.set(false);
    }
  }

  async applyBokeh(): Promise<void> {
    clearTimeout(this.previewTimer);
    const focus = this.bokehFocus();
    const strength = this.bokehStrength();
    await this.runEngine(async () => {
      const { bokeh } = await import('../../../core/editing/engines/bokeh-engine');
      await this.session.applyEngine((buf) => bokeh(buf, { focus, strength }));
    });
  }

  private async runSelect(): Promise<void> {
    await this.runEngine(async () => {
      const buf = this.session.current();
      const points = this.selPoints();
      if (!buf || !points.length) return;
      const { smartSelect } = await import('../../../core/editing/engines/select-engine');
      const mask = await smartSelect(buf, points);
      if (this.tool() !== 'select') return;
      this.selMask.set(mask);
      this.session.showPreviewBuffer(tintMask(buf, mask));
    });
  }

  /** Smart select → MI-GAN inpaint: the clicked object disappears. */
  async selectRemove(): Promise<void> {
    const mask = this.selMask();
    if (!mask) return;
    this.selectClear();
    await this.session.applyHeal(mask);
  }

  /** Smart select → keep only the object, transparent elsewhere. */
  async selectCutout(): Promise<void> {
    const mask = this.selMask();
    if (!mask) return;
    this.selectClear();
    await this.runEngine(async () => {
      const { cutToMask } = await import('../../../core/editing/engines/select-engine');
      await this.session.applyEngine((buf) => Promise.resolve(cutToMask(buf, mask)));
    });
  }

  selectClear(): void {
    this.selMask.set(null);
    this.selPoints.set([]);
    this.selMode.set('add');
    this.session.resetPreview();
  }

  /** Selection → AI Remove: FLUX-fill erases the object, scoped to the mask. */
  async selectAiRemove(): Promise<void> {
    const png = await this.selectionMaskPng();
    if (!png) return;
    this.selectClear();
    this.aiSelection.emit({ toolId: 'edit-remove', prompt: '', maskPngBase64: png });
  }

  /** Selection → AI Fill: repaint ONLY the selected area from the prompt. */
  async selectAiFill(): Promise<void> {
    const prompt = this.selPrompt().trim();
    const png = await this.selectionMaskPng();
    if (!png || !prompt) return;
    this.selectClear();
    this.selPrompt.set('');
    this.aiSelection.emit({ toolId: 'edit-fill', prompt, maskPngBase64: png });
  }

  /** Selection mask as the white-on-black PNG data URI FLUX fill expects,
   * grown a few px so no rim of the original object survives the repaint. */
  private async selectionMaskPng(): Promise<string | null> {
    const mask = this.selMask();
    const buf = this.session.current();
    if (!mask || !buf) return null;
    const { dilateMask } = await import('../../../core/editing/engines/raster');
    const grown = dilateMask(mask, buf.width, buf.height, 4);
    const canvas = document.createElement('canvas');
    canvas.width = buf.width;
    canvas.height = buf.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(buf.width, buf.height);
    for (let i = 0; i < grown.length; i++) {
      const v = grown[i] ? 255 : 0;
      const p = i * 4;
      img.data[p] = v;
      img.data[p + 1] = v;
      img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  private async runEngine(task: () => Promise<void>): Promise<void> {
    this.engineError.set('');
    this.engineBusy.set(true);
    try {
      await task();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      this.engineError.set(
        msg === 'too_large'
          ? 'Image too large for on-device upscaling — the limit is 16 MP (4096×4096).'
          : /fetch|network/i.test(msg) || !msg
            ? 'Engine failed to load — check your connection and try again.'
            : `Engine error: ${msg}`,
      );
    } finally {
      this.engineBusy.set(false);
    }
  }

  /** Gamma slider value as the real coefficient, e.g. 100 → "1.00". */
  gammaLabel(): string {
    return (this.levelsGamma() / 100).toFixed(2);
  }

  private levelsParams(): { black: number; white: number; gamma: number } {
    // Never let black meet white — the op guards too, but keep the UI sane.
    const black = Math.min(this.levelsBlack(), 254);
    const white = Math.max(this.levelsWhite(), black + 1);
    return { black, white, gamma: this.levelsGamma() / 100 };
  }

  /** Bokeh slider drag re-renders the preview with the cached depth map. */
  onBokehStrength(v: number): void {
    this.bokehStrength.set(v);
    this.scheduleBokehPreview();
  }

  private drawHistogram(): void {
    const canvas = this.histCanvas()?.nativeElement;
    // Preview pixels when a levels preview is up — the bars follow the sliders.
    const buf = this.session.previewBuffer() ?? this.session.current();
    if (!canvas || !buf) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // non-browser test envs
    const bins = lumaHistogram(buf);
    const { width: cw, height: ch } = canvas;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgb(255 255 255 / 0.45)';
    for (let v = 0; v < 256; v++) {
      const barH = Math.max(bins[v] > 0 ? 1 : 0, bins[v] * ch);
      ctx.fillRect((v / 256) * cw, ch - barH, cw / 256, barH);
    }
  }
}

/** Selection highlight: masked pixels blended toward the accent purple. */
function tintMask(buf: PixelBuffer, mask: Uint8Array): PixelBuffer {
  const out: PixelBuffer = {
    width: buf.width,
    height: buf.height,
    data: new Uint8ClampedArray(buf.data),
  };
  const d = out.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    d[p] = d[p] * 0.55 + 130 * 0.45;
    d[p + 1] = d[p + 1] * 0.55 + 90 * 0.45;
    d[p + 2] = d[p + 2] * 0.55 + 255 * 0.45;
  }
  return out;
}
