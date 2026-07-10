import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { healModelProgress } from '../../../core/editing/heal-status';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
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
  /** Shared with the viewport — heal/liquify/mask brushes read the same size. */
  readonly brushSize = model(40);
  /** Shared with the viewport — locked crop ratio, null = free. */
  readonly cropAspect = model<number | null>(null);
  readonly liquifyMode = model<LiquifyMode>('push');
  /** 0..100, scales liquify displacement. */
  readonly liquifyStrength = model(50);

  readonly cropPresets = CROP_PRESETS;
  readonly liquifyModes = LIQUIFY_MODES;
  /** MI-GAN model download %, first heal only — null when idle. */
  readonly healPct = computed(() => {
    const p = healModelProgress();
    return p === null ? null : Math.round(p * 100);
  });
  readonly brightness = signal(0);
  readonly contrast = signal(0);
  readonly saturation = signal(0);
  readonly amount = signal(50);

  private previewTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Switching tools drops any un-applied preview and resets the sliders.
    effect(() => {
      this.tool();
      untracked(() => this.resetPending());
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
    }
  }

  private resetPending(): void {
    clearTimeout(this.previewTimer);
    this.brightness.set(0);
    this.contrast.set(0);
    this.saturation.set(0);
    this.amount.set(50); // sharpen/smooth must not inherit each other's value
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
}
