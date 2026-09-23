// State and preview/apply logic for the tools that go through the session's
// live-preview pipeline: adjust, sharpen, smooth, crop (rotate/flip/
// straighten), filters, enhance, dehaze, portrait smooth, levels and
// perspective. One `PreviewScheduler` coalesces every slider drag into one
// compute per frame, same as before this was split out of `tool-options.ts`.
import { ModelSignal, signal } from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { PREVIEW_MAX_DIM } from '../../../core/editing/editor-policy';
import { PreviewScheduler } from '../../../core/editing/preview-scheduler';
import { FilterPreset } from '../../../core/editing/ops/filters';
import { lumaHistogram } from '../../../core/editing/ops/levels';
import { FlipAxis } from '../../../core/editing/ops/transform';
import { PixelBuffer } from '../../../core/editing/pixel-buffer';
import { StudioTool } from '../studio-tool';
export class PreviewOpsController {
  readonly brightness = signal(0);
  readonly contrast = signal(0);
  readonly saturation = signal(0);
  readonly amount = signal(50);
  /** −45..45°, live-previews without crop; Apply crops to the inside rect. */
  readonly straightenDeg = signal(0);
  readonly filterPreset = signal<FilterPreset>('bw');
  readonly filterIntensity = signal(80);
  /** Duotone shadow/highlight tints (RGB) — only read by that preset. */
  readonly duotoneA = signal<[number, number, number]>([26, 22, 55]);
  readonly duotoneB = signal<[number, number, number]>([245, 226, 168]);
  readonly enhanceStrength = signal(80);
  readonly levelsBlack = signal(0);
  readonly levelsWhite = signal(255);
  /** Stored ×100 so the range input stays integer (20..300 → 0.2..3.0). */
  readonly levelsGamma = signal(100);
  readonly perspV = signal(0);
  readonly perspH = signal(0);
  readonly dehazeStrength = signal(60);
  readonly portraitStrength = signal(60);

  /** One preview compute per animation frame — slider drags coalesce. */
  private readonly previewSched = new PreviewScheduler(() => this.runPreview());

  constructor(
    private readonly session: EditSession,
    private readonly tool: () => StudioTool | null,
    private readonly cropAspect: ModelSignal<number | null>,
  ) {}

  /** Live preview, coalesced to one compute per frame — no history commit. */
  schedulePreview(): void {
    this.previewSched.schedule();
  }

  cancelPreview(): void {
    this.previewSched.cancel();
  }

  private async runPreview(): Promise<void> {
    const t = this.tool();
    if (t === 'adjust') {
      await this.session.previewOp(
        'adjust',
        {
          brightness: this.brightness(),
          contrast: this.contrast(),
          saturation: this.saturation(),
        },
        PREVIEW_MAX_DIM,
      );
    } else if (t === 'sharpen') {
      await this.session.previewOp('sharpen', this.amount(), PREVIEW_MAX_DIM);
    } else if (t === 'smooth') {
      await this.session.previewOp('smooth', this.amount(), PREVIEW_MAX_DIM);
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
      await this.session.previewOp(
        'filter',
        {
          preset: this.filterPreset(),
          intensity: this.filterIntensity(),
          colorA: this.duotoneA(),
          colorB: this.duotoneB(),
        },
        PREVIEW_MAX_DIM,
      );
    } else if (t === 'enhance') {
      await this.session.previewOp('enhance', this.enhanceStrength(), PREVIEW_MAX_DIM);
    } else if (t === 'dehaze') {
      await this.session.previewOp('dehaze', { strength: this.dehazeStrength() }, PREVIEW_MAX_DIM);
    } else if (t === 'portraitsmooth') {
      await this.session.previewOp(
        'portraitSmooth',
        { strength: this.portraitStrength() },
        PREVIEW_MAX_DIM,
      );
    } else if (t === 'levels') {
      await this.session.previewOp('levels', this.levelsParams(), PREVIEW_MAX_DIM);
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

  /** Drop any un-applied preview and put every slider back at its default. */
  reset(): void {
    this.previewSched.cancel();
    this.brightness.set(0);
    this.contrast.set(0);
    this.saturation.set(0);
    this.amount.set(50); // sharpen/smooth must not inherit each other's value
    this.straightenDeg.set(0);
    this.filterPreset.set('bw');
    this.filterIntensity.set(80);
    this.duotoneA.set([26, 22, 55]);
    this.duotoneB.set([245, 226, 168]);
    this.enhanceStrength.set(80);
    this.levelsBlack.set(0);
    this.levelsWhite.set(255);
    this.levelsGamma.set(100);
    this.perspV.set(0);
    this.perspH.set(0);
    this.dehazeStrength.set(60);
    this.portraitStrength.set(60);
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

  hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  rgbToHex([r, g, b]: [number, number, number]): string {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  setDuotone(which: 'a' | 'b', hex: string): void {
    (which === 'a' ? this.duotoneA : this.duotoneB).set(this.hexToRgb(hex));
    this.schedulePreview();
  }

  async applyAdjust(): Promise<void> {
    this.previewSched.cancel();
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
    this.previewSched.cancel();
    await this.session.apply('sharpen', this.amount());
  }

  async applySmooth(): Promise<void> {
    this.previewSched.cancel();
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
    this.previewSched.cancel();
    const degrees = this.straightenDeg();
    if (degrees === 0) return;
    await this.session.apply('straighten', { degrees, crop: true });
    this.straightenDeg.set(0);
  }

  async applyFilter(): Promise<void> {
    this.previewSched.cancel();
    await this.session.apply('filter', {
      preset: this.filterPreset(),
      intensity: this.filterIntensity(),
      colorA: this.duotoneA(),
      colorB: this.duotoneB(),
    });
  }

  async applyEnhance(): Promise<void> {
    this.previewSched.cancel();
    await this.session.apply('enhance', this.enhanceStrength());
  }

  async applyDehaze(): Promise<void> {
    this.previewSched.cancel();
    await this.session.apply('dehaze', { strength: this.dehazeStrength() });
  }

  async applyPortrait(): Promise<void> {
    this.previewSched.cancel();
    await this.session.apply('portraitSmooth', { strength: this.portraitStrength() });
  }

  async applyLevels(): Promise<void> {
    this.previewSched.cancel();
    await this.session.apply('levels', this.levelsParams());
    this.levelsBlack.set(0);
    this.levelsWhite.set(255);
    this.levelsGamma.set(100);
  }

  async applyPerspective(): Promise<void> {
    this.previewSched.cancel();
    if (this.perspV() === 0 && this.perspH() === 0) return;
    await this.session.apply('perspective', {
      vertical: this.perspV(),
      horizontal: this.perspH(),
    });
    this.perspV.set(0);
    this.perspH.set(0);
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

  /** Redraw the Levels histogram from whichever pixels are on screen —
   * the preview buffer while a slider is live, committed pixels otherwise. */
  drawHistogram(canvas: HTMLCanvasElement | undefined): void {
    const buf = this.session.previewBuffer() ?? this.session.current();
    if (!canvas || !buf) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // non-browser test envs
    const bins = lumaHistogram(buf as PixelBuffer);
    const { width: cw, height: ch } = canvas;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgb(255 255 255 / 0.45)';
    for (let v = 0; v < 256; v++) {
      const barH = Math.max(bins[v] > 0 ? 1 : 0, bins[v] * ch);
      ctx.fillRect((v / 256) * cw, ch - barH, cw / 256, barH);
    }
  }
}
