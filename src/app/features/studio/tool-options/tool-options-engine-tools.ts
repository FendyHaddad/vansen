import { computed, signal } from '@angular/core';
import { EDIT_TOOLS } from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
import {
  SelectionStamp,
  StampedSelection,
  stampMatches,
  usableMask,
} from '../../../core/editing/selection-stamp';
import { MAX_DEBLUR_PIXELS, MAX_UPSCALE_PIXELS } from '../../../core/editing/engines/engine-status';
import {
  HEAVY_PREVIEW_DEBOUNCE_MS,
  PixelBudgetError,
  PREVIEW_MAX_DIM,
  scalePoint,
} from '../../../core/editing/editor-policy';
import { PreviewScheduler } from '../../../core/editing/preview-scheduler';
// Type-only: a value import would drag onnxruntime into the eager bundle.
import type { SelectPoint } from '../../../core/editing/engines/select-engine';
import {
  cutoutModelProgress,
  deblurModelProgress,
  deblurTileProgress,
  depthModelProgress,
  samModelProgress,
  upscaleModelProgress,
  upscaleTileProgress,
} from '../../../core/editing/engines/engine-status';
import { healModelProgress } from '../../../core/editing/heal-status';
import { PixelBuffer } from '../../../core/editing/pixel-buffer';
import { StudioTool } from '../studio-tool';

/** Payload for an AI edit scoped to the selection mask — the workspace runs the job. */
export interface AiSelectionRequest {
  toolId: string;
  prompt: string;
  maskPngBase64: string;
}

/**
 * State and run logic for the on-device (ONNX) and selection-driven tools:
 * Cut Out, Upscale 2×, AI Sharpen, Magic Erase, Bokeh and Smart Select — plus
 * AI Remove/Fill on a selection. Split out of `tool-options.ts`; the click
 * routing that feeds `runErase`/`runSelect`/the bokeh focus still lives on
 * the panel component (it reacts to the session's shared `pointPick`
 * regardless of which tool group is active), which calls straight through
 * to the methods here.
 */
export class EngineToolsController {
  /** 0..100, scales the bokeh blur. */
  readonly bokehStrength = signal(50);
  /** Focus point in image px; null = center until the user clicks. */
  readonly bokehFocus = signal<{ x: number; y: number } | null>(null);
  /**
   * Smart-select mask for the clicked object, stamped with the session it was
   * computed in.
   *
   * A mask is a per-pixel map of ONE image at ONE moment. A crop, a rotate,
   * an undo or a different image all invalidate it, and applying it anyway
   * either throws on a length mismatch or — worse — erases the wrong part of
   * the picture.
   */
  private readonly selectionSig = signal<StampedSelection | null>(null);
  /** Template binding: is there a selection at all. */
  readonly selMask = computed(() => this.selectionSig()?.mask ?? null);
  /** All selection clicks so far — SAM refines the mask from the full set. */
  readonly selPoints = signal<SelectPoint[]>([]);
  /** Whether the next click grows or carves the selection. */
  readonly selMode = signal<'add' | 'subtract'>('add');
  /** Prompt for AI Fill on the selected area. */
  readonly selPrompt = signal('');
  /** Credit prices for the AI-on-selection buttons. */
  readonly aiRemovePrice = EDIT_TOOLS.find((t) => t.id === 'edit-remove')?.creditCost ?? 0;
  readonly aiFillPrice = EDIT_TOOLS.find((t) => t.id === 'edit-fill')?.creditCost ?? 0;
  /** True while an engine (ONNX) call runs from this strip. */
  readonly engineBusy = signal(false);
  readonly engineError = signal('');

  /** MI-GAN model download %, first heal only — null when idle. */
  readonly healPct = computed(() => {
    const p = healModelProgress();
    return p === null ? null : Math.round(p * 100);
  });
  /** First-use model download % for whichever engine tool is open. */
  readonly enginePct = computed(() => {
    const p =
      cutoutModelProgress() ??
      depthModelProgress() ??
      upscaleModelProgress() ??
      deblurModelProgress() ??
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
  /** AI Sharpen inference progress %, null when idle. */
  readonly deblurPct = computed(() => {
    const p = deblurTileProgress();
    return p === null ? null : Math.round(p * 100);
  });
  readonly deblurTooLarge = computed(() => {
    const s = this.imageSize();
    return !!s && s.w * s.h > MAX_DEBLUR_PIXELS;
  });

  private bokehToken = 0;

  /**
   * Bokeh is heavier (ONNX), so it debounces instead of running per frame —
   * and the scheduler keeps exactly one run in flight, with at most one
   * replacement waiting. A drag used to start a new depth pass on top of the
   * last one for as long as it lasted.
   */
  private readonly bokehPreview = new PreviewScheduler(
    () => this.runBokehPreview(),
    (cb) => setTimeout(() => cb(0), HEAVY_PREVIEW_DEBOUNCE_MS) as unknown as number,
    (handle) => clearTimeout(handle),
  );

  constructor(
    private readonly session: EditSession,
    private readonly tool: () => StudioTool | null,
    private readonly emitAiSelection: (payload: AiSelectionRequest) => void,
  ) {}

  /** Drop any un-applied engine preview and clear the selection/bokeh state. */
  reset(): void {
    this.bokehPreview.cancel();
    this.bokehStrength.set(50);
    this.bokehFocus.set(null);
    this.selectionSig.set(null);
    this.selPoints.set([]);
    this.selMode.set('add');
    this.selPrompt.set('');
    this.engineError.set('');
  }

  cancelBokehPreview(): void {
    this.bokehPreview.cancel();
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

  /** AI Sharpen: tiled NAFNet deblur, on-device. */
  async runAiSharpen(): Promise<void> {
    await this.runEngine(async () => {
      const { deblur } = await import('../../../core/editing/engines/deblur-engine');
      await this.session.applyEngine(deblur);
    });
  }

  /** Magic Erase: tap an object → SAM mask → grow → MI-GAN inpaint it away. */
  async runErase(point: SelectPoint): Promise<void> {
    await this.runEngine(async () => {
      const buf = this.session.current();
      if (!buf) return;
      const stamp = this.stamp(buf);
      const { smartSelect } = await import('../../../core/editing/engines/select-engine');
      const mask = await smartSelect(buf, [point]);
      // SAM took a while. If the pixels moved, healing this mask would erase
      // whatever is now in that rectangle.
      if (!this.stampMatches(stamp)) {
        this.engineError.set('The image changed — tap the object again.');
        return;
      }
      const { dilateMask } = await import('../../../core/editing/engines/raster');
      const grown = dilateMask(mask, buf.width, buf.height, 3);
      await this.session.applyHeal(grown);
    });
  }

  scheduleBokehPreview(): void {
    this.bokehPreview.schedule();
  }

  private async runBokehPreview(): Promise<void> {
    const token = ++this.bokehToken;
    // Previews run on the proxy: a full-resolution depth pass per slider
    // notch is seconds of inference for an answer nobody can see at that
    // size. The commit still runs on the real pixels.
    const proxy = this.session.proxy(PREVIEW_MAX_DIM);
    if (!proxy) return;
    this.engineError.set('');
    this.engineBusy.set(true);
    try {
      const { bokeh } = await import('../../../core/editing/engines/bokeh-engine');
      const out = await bokeh(proxy.buf, {
        // The focus point was picked on the full image.
        focus: scalePoint(this.bokehFocus(), proxy.scale),
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
    this.bokehPreview.cancel();
    const focus = this.bokehFocus();
    const strength = this.bokehStrength();
    await this.runEngine(async () => {
      const { bokeh } = await import('../../../core/editing/engines/bokeh-engine');
      await this.session.applyEngine((buf) => bokeh(buf, { focus, strength }));
    });
  }

  async runSelect(): Promise<void> {
    await this.runEngine(async () => {
      const buf = this.session.current();
      const points = this.selPoints();
      if (!buf || !points.length) return;
      const stamp = this.stamp(buf);
      const { smartSelect } = await import('../../../core/editing/engines/select-engine');
      const mask = await smartSelect(buf, points);
      if (this.tool() !== 'select') return;
      // The image may have changed while the model ran.
      if (!this.stampMatches(stamp)) return;
      this.selectionSig.set({ ...stamp, mask });
      this.session.showPreviewBuffer(tintMask(buf, mask));
    });
  }

  /** Route a canvas click for the select tool — first click is always additive. */
  addSelectPoint(pick: { x: number; y: number }): void {
    const label: 0 | 1 = this.selPoints().length && this.selMode() === 'subtract' ? 0 : 1;
    this.selPoints.update((pts) => [...pts, { x: pick.x, y: pick.y, label }]);
  }

  /** What identifies the pixels a mask was computed from. */
  private stamp(buf: PixelBuffer): SelectionStamp {
    return {
      token: this.session.openToken(),
      revision: this.session.revision(),
      width: buf.width,
      height: buf.height,
    };
  }

  private stampMatches(stamp: SelectionStamp): boolean {
    const now = this.currentStamp();
    return !!now && stampMatches(stamp, now);
  }

  private currentStamp(): SelectionStamp | null {
    const buf = this.session.current();
    if (!buf) return null;
    return this.stamp(buf);
  }

  /**
   * The selection, but only if it still describes the pixels on screen.
   *
   * Anything else is refused with something the customer can act on, BEFORE
   * a model runs or a buffer is allocated.
   */
  private usableSelection(): Uint8Array | null {
    const selection = this.selectionSig();
    if (!selection) return null;
    const mask = usableMask(selection, this.currentStamp());
    if (mask) return mask;
    this.selectClear();
    this.engineError.set('The image changed — select the area again.');
    return null;
  }

  /** Smart select → MI-GAN inpaint: the clicked object disappears. */
  async selectRemove(): Promise<void> {
    const mask = this.usableSelection();
    if (!mask) return;
    this.selectClear();
    await this.session.applyHeal(mask);
  }

  /** Smart select → keep only the object, transparent elsewhere. */
  async selectCutout(): Promise<void> {
    const mask = this.usableSelection();
    if (!mask) return;
    this.selectClear();
    await this.runEngine(async () => {
      const { cutToMask } = await import('../../../core/editing/engines/select-engine');
      await this.session.applyEngine((buf) => Promise.resolve(cutToMask(buf, mask)));
    });
  }

  selectClear(): void {
    this.selectionSig.set(null);
    this.selPoints.set([]);
    this.selMode.set('add');
    this.session.resetPreview();
  }

  /** Selection → AI Remove: FLUX-fill erases the object, scoped to the mask. */
  async selectAiRemove(): Promise<void> {
    const png = await this.selectionMaskPng();
    if (!png) return;
    this.selectClear();
    this.emitAiSelection({ toolId: 'edit-remove', prompt: '', maskPngBase64: png });
  }

  /** Selection → AI Fill: repaint ONLY the selected area from the prompt. */
  async selectAiFill(): Promise<void> {
    const prompt = this.selPrompt().trim();
    const png = await this.selectionMaskPng();
    if (!png || !prompt) return;
    this.selectClear();
    this.selPrompt.set('');
    this.emitAiSelection({ toolId: 'edit-fill', prompt, maskPngBase64: png });
  }

  /** Selection mask as the white-on-black PNG data URI FLUX fill expects,
   * grown a few px so no rim of the original object survives the repaint. */
  private async selectionMaskPng(): Promise<string | null> {
    const mask = this.usableSelection();
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
        // A size refusal already carries the sentence a customer should read.
        e instanceof PixelBudgetError
          ? `${msg} The limit is 16 MP (4096×4096).`
          : /fetch|network/i.test(msg) || !msg
            ? 'Engine failed to load — check your connection and try again.'
            : `Engine error: ${msg}`,
      );
    } finally {
      this.engineBusy.set(false);
    }
  }

  /** Bokeh slider drag re-renders the preview with the cached depth map. */
  onBokehStrength(v: number): void {
    this.bokehStrength.set(v);
    this.scheduleBokehPreview();
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
