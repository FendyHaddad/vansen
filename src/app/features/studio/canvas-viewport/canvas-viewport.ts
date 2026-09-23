// Center stage in edit mode: the working image + paintable mask overlay.
// Pan/zoom gesture state lives in `ViewportPanZoom`, crop-box gesture state
// in `CropGesture`, heal/liquify/clone/retouch stroke bookkeeping in
// `BrushStrokes` (all beside this file). This component owns the DOM/pointer
// wiring, the tool input signals, and the screen-space overlay computeds.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { MaskCanvas } from '../mask-canvas/mask-canvas';
import { DRAG_TOOLS, StudioTool } from '../studio-tool';
import { BrushStrokes } from './brush-strokes';
import { CropHandle, MIN_CROP_PX, CropGesture } from './crop-geometry';
import { ViewportPanZoom } from './pan-zoom';
import { clamp } from './viewport-math';

@Component({
  selector: 'app-canvas-viewport',
  templateUrl: './canvas-viewport.html',
  styleUrl: './canvas-viewport.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MaskCanvas],
})
export class CanvasViewport {
  readonly session = inject(EditSession);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly maskCanvas = viewChild(MaskCanvas);

  readonly tool = input<StudioTool | null>(null);
  readonly brushSize = input(40);
  /** Locked crop ratio (w/h) from the preset picker; null = free-form. */
  readonly cropAspect = input<number | null>(null);
  readonly liquifyMode = input<LiquifyMode>('push');
  /** 0..100 from the panel slider. */
  readonly liquifyStrength = input(50);
  readonly retouchMode = input<RetouchMode>('lighten');
  /** 0..100 from the panel slider. */
  readonly retouchStrength = input(50);
  /** 0..100 edge softness for the retouch brush. */
  readonly retouchFeather = input(50);
  /** 0..100 clone dab opacity. */
  readonly cloneStrength = input(100);

  private readonly previewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private readonly cloneCanvas = viewChild<ElementRef<HTMLCanvasElement>>('cloneCanvas');

  private readonly panZoom = new ViewportPanZoom();
  private readonly crop = new CropGesture();
  private readonly strokes = new BrushStrokes(this.session);

  /** Bumped on resize/layout so screen-space computeds re-measure the DOM. */
  private readonly viewTick = signal(0);
  /** Pointer position relative to the viewport, for the brush cursor ring. */
  readonly cursorPos = signal<{ x: number; y: number } | null>(null);

  /** Grab cursor: zoomed in and the active tool leaves left-drag free. */
  readonly pannable = computed(() => {
    if (this.session.zoom() <= 1) return false;
    const t = this.tool();
    return t === null || !DRAG_TOOLS.has(t);
  });
  readonly panning = computed(() => this.panZoom.isDragging());

  /** Zoom + pan applied to the stage. Overlay math needs no special casing —
   * it measures the transformed DOM rects. */
  readonly stageTransform = computed(() => {
    const z = this.session.zoom();
    const p = this.panZoom.pan();
    return z === 1 && p.x === 0 && p.y === 0
      ? ''
      : `translate(${p.x}px, ${p.y}px) scale(${z})`;
  });
  /** Screen-space stroke trail shown while dragging heal/liquify. */
  readonly strokeTrail = signal<{ x: number; y: number }[]>([]);

  readonly trailPoints = computed(() =>
    this.strokeTrail()
      .map((p) => `${p.x},${p.y}`)
      .join(' '),
  );

  /** Displayed image's box relative to the viewport — anchors overlays. */
  readonly imgCss = computed(() => {
    this.viewTick();
    this.session.previewBuffer(); // re-measure when the overlay appears
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp || img.width === 0) return null;
    return { left: img.left - vp.left, top: img.top - vp.top, width: img.width, height: img.height };
  });

  /** Crop box in viewport-relative CSS pixels (image may be letterboxed). */
  readonly cropCss = computed(() => {
    this.viewTick();
    const r = this.crop.rect();
    const buf = this.session.current();
    if (!r || !buf) return null;
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp || img.width === 0 || img.height === 0) return null;
    const sx = img.width / buf.width;
    const sy = img.height / buf.height;
    return {
      left: img.left - vp.left + r.x * sx,
      top: img.top - vp.top + r.y * sy,
      width: r.width * sx,
      height: r.height * sy,
    };
  });

  /** Live crop size caption (image pixels), e.g. "512 × 384". */
  readonly cropSize = computed(() => {
    const r = this.crop.rect();
    return r ? `${Math.round(r.width)} × ${Math.round(r.height)}` : '';
  });

  readonly handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  readonly brushToolActive = computed(() => {
    const t = this.tool();
    return t === 'heal' || t === 'liquify' || t === 'clone' || t === 'retouch';
  });

  /** Crosshair cursor for the click-to-pick tools. */
  readonly pickToolActive = computed(() => {
    const t = this.tool();
    return t === 'bokeh' || t === 'select' || t === 'erase';
  });

  /** Clone-stamp sample point in image px; null until the user marks one. */
  readonly cloneSource = signal<{ x: number; y: number } | null>(null);
  /** Alt/⌥ held — clone switches to source-pick mode (crosshair cursor). */
  readonly altHeld = signal(false);
  /** True while a clone paint drag is running (hides the in-brush preview). */
  readonly cloneDragging = signal(false);
  /** Crosshair while the next clone click will (re)mark the source. */
  readonly clonePicking = computed(
    () => this.tool() === 'clone' && (this.altHeld() || !this.cloneSource()),
  );
  /** Committed pixels as an <img> for painting the in-brush clone preview. */
  private readonly cloneImg = signal<HTMLImageElement | null>(null);
  /** Photoshop-style: the brush circle previews the pixels it would stamp. */
  readonly clonePreviewOn = computed(
    () =>
      this.tool() === 'clone' &&
      !!this.cloneSource() &&
      !this.clonePicking() &&
      !this.cloneDragging() &&
      !!this.cloneImg(),
  );
  /** Integer canvas edge for the in-brush preview. */
  readonly brushPx = computed(() => Math.max(2, Math.round(this.brushCursorPx())));

  /** Bokeh focus reticle in viewport CSS px — where the last click landed. */
  readonly focusMarkerCss = computed(() => {
    this.viewTick();
    if (this.tool() !== 'bokeh') return null;
    const p = this.session.pointPick();
    const buf = this.session.current();
    if (!p || !buf) return null;
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp || img.width === 0 || buf.width === 0) return null;
    return {
      x: img.left - vp.left + (p.x / buf.width) * img.width,
      y: img.top - vp.top + (p.y / buf.height) * img.height,
    };
  });

  /** Clone source marker in viewport CSS px. */
  readonly cloneMarkerCss = computed(() => {
    this.viewTick();
    if (this.tool() !== 'clone') return null;
    const src = this.cloneSource();
    const buf = this.session.current();
    if (!src || !buf) return null;
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp || img.width === 0 || buf.width === 0) return null;
    return {
      x: img.left - vp.left + (src.x / buf.width) * img.width,
      y: img.top - vp.top + (src.y / buf.height) * img.height,
    };
  });

  /** Brush ring diameter in screen px, matching what the tool will touch. */
  readonly brushCursorPx = computed(() => {
    this.viewTick();
    const buf = this.session.current();
    const img = this.imgRect();
    if (!buf || !img || buf.width === 0) return this.brushSize();
    // heal/liquify use brushSize as a RADIUS in image pixels
    return this.brushSize() * 2 * (img.width / buf.width);
  });

  constructor() {
    // Entering crop shows a ready-made centered box; preset changes re-fit it.
    effect(() => {
      const t = this.tool();
      const aspect = this.cropAspect();
      this.session.previewUrl(); // re-init after loads / rotations change dims
      if (t === 'crop') this.initCropBox(aspect);
      else this.crop.clear();
    });
    // The mask layer keeps its own brush size — mirror the panel's slider.
    effect(() => {
      const mc = this.maskCanvas();
      if (mc) mc.brushSize.set(this.brushSize());
    });
    // Paint the uncommitted slider preview straight onto the overlay canvas.
    effect(() => {
      const c = this.previewCanvas()?.nativeElement;
      const buf = this.session.previewBuffer();
      if (!c || !buf) return;
      if (c.width !== buf.width || c.height !== buf.height) {
        c.width = buf.width;
        c.height = buf.height;
      }
      c.getContext('2d')?.putImageData(
        new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height),
        0,
        0,
      );
    });
    // Zoom changes: drop or re-clamp the pan, then re-measure once the new
    // transform has painted so every overlay lands on the moved image.
    effect(() => {
      const z = this.session.zoom();
      if (z <= 1) this.panZoom.reset();
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          this.clampPan();
          this.viewTick.update((n) => n + 1);
        });
      }
    });
    // New image = fresh framing.
    effect(() => {
      this.session.previewUrl();
      this.panZoom.reset();
    });
    // Any tool switch or image swap forgets the clone source mark.
    effect(() => {
      this.tool();
      this.session.item();
      this.cloneSource.set(null);
    });
    // Decoded committed pixels for the in-brush clone preview — only kept
    // while the clone tool is open.
    effect(() => {
      const url = this.session.previewUrl();
      if (this.tool() !== 'clone' || !url || typeof Image === 'undefined') {
        this.cloneImg.set(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        // A newer commit may have replaced the URL while this one decoded.
        if (this.session.previewUrl() === url) this.cloneImg.set(img);
      };
      img.src = url;
    });
    // Paint the source neighborhood into the brush circle — what the next
    // stroke will stamp (non-aligned clone starts at the source).
    effect(() => {
      const canvas = this.cloneCanvas()?.nativeElement;
      const img = this.cloneImg();
      const src = this.cloneSource();
      const edge = this.brushPx();
      if (!canvas || !img || !src || !this.clonePreviewOn()) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const r = this.brushSize(); // radius in image px
      ctx.clearRect(0, 0, edge, edge);
      ctx.drawImage(img, src.x - r, src.y - r, r * 2, r * 2, 0, 0, edge, edge);
    });
    if (typeof window !== 'undefined') {
      const bump = () => this.viewTick.update((n) => n + 1);
      window.addEventListener('resize', bump);
      // Alt/⌥ toggles clone source-pick mode; window blur can eat the keyup.
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Alt') this.altHeld.set(e.type === 'keydown');
      };
      const onBlur = () => this.altHeld.set(false);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      window.addEventListener('blur', onBlur);
      inject(DestroyRef).onDestroy(() => {
        window.removeEventListener('resize', bump);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        window.removeEventListener('blur', onBlur);
      });
    }
  }

  /** Trackpad/wheel: pan while zoomed in; ctrl+wheel (pinch) zooms. */
  onWheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) this.session.zoomIn();
      else this.session.zoomOut();
      return;
    }
    if (this.session.zoom() <= 1) return;
    e.preventDefault();
    this.panZoom.panBy(e.deltaX, e.deltaY);
    this.clampPan();
    this.viewTick.update((n) => n + 1);
  }

  private clampPan(): void {
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp) return;
    this.panZoom.clamp(img.width, img.height, vp.width, vp.height);
  }

  private initCropBox(aspect: number | null): void {
    const buf = this.session.current();
    this.crop.initBox(buf, aspect);
    // The <img> may not be laid out yet — re-measure once it is.
    if (!buf) return;
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => this.viewTick.update((n) => n + 1));
    }
  }

  /** The displayed image's box; crop math maps screen ↔ image pixels through it. */
  private imgRect(): DOMRect | null {
    const img = this.host.nativeElement.querySelector('img');
    return img ? img.getBoundingClientRect() : null;
  }

  private vpRect(): DOMRect | null {
    const vp = this.host.nativeElement.querySelector('.viewport');
    return vp ? vp.getBoundingClientRect() : null;
  }

  /** Screen point → image-pixel point, clamped to the image bounds. */
  private toImagePoint(e: PointerEvent): { x: number; y: number } | null {
    const buf = this.session.current();
    const r = this.imgRect();
    if (!buf || !r || r.width === 0 || r.height === 0) return null;
    return {
      x: clamp(((e.clientX - r.x) / r.width) * buf.width, 0, buf.width),
      y: clamp(((e.clientY - r.y) / r.height) * buf.height, 0, buf.height),
    };
  }

  /** Begin a move/resize gesture from a crop handle or the box body. */
  startCropDrag(e: PointerEvent, mode: 'move' | CropHandle): void {
    if (e.button !== 0) return; // middle-drag bubbles up to the viewport pan
    e.stopPropagation();
    const p = this.toImagePoint(e);
    if (!p) return;
    if (!this.crop.beginHandleDrag(mode, p)) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  onPointerDown(e: PointerEvent): void {
    this.updateCursor(e);
    // Click-drag pan for mouse users: free left-drag, or middle-drag with any tool.
    if (this.session.zoom() > 1 && (e.button === 1 || (e.button === 0 && this.pannable()))) {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.panZoom.startDrag(e.clientX, e.clientY);
      return;
    }
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop') {
      // Click on empty canvas draws a fresh box.
      this.crop.beginNew(p);
    }
    if (t === 'heal' || t === 'liquify' || t === 'clone' || t === 'retouch') {
      const cp = this.cursorPos();
      this.strokeTrail.set(cp ? [cp] : []);
    }
    if (t === 'heal') this.strokes.beginHeal(p);
    if (t === 'liquify') {
      this.strokes.beginLiquify(p, this.liquifyMode(), this.brushSize(), this.liquifyStrength());
    }
    if (t === 'clone' && e.button === 0) {
      // First click (or alt-click any time) marks the sample spot; painting
      // starts once a source exists.
      const src = this.cloneSource();
      if (e.altKey || !src) {
        this.cloneSource.set(p);
        this.strokeTrail.set([]);
        return;
      }
      this.cloneDragging.set(true);
      this.strokes.beginClone(src, p, this.brushSize(), this.cloneStrength());
    }
    if (t === 'retouch' && e.button === 0) {
      this.strokes.beginRetouch(p, this.brushSize(), this.retouchMode(), this.retouchStrength(), this.retouchFeather());
    }
    // Point-pick tools: bokeh focus, smart select, magic erase. Tool options react.
    if ((t === 'bokeh' || t === 'select' || t === 'erase') && e.button === 0) {
      this.session.setPointPick(p);
    }
  }

  onPointerMove(e: PointerEvent): void {
    this.updateCursor(e);
    if (this.panZoom.isDragging()) {
      this.panZoom.updateDrag(e.clientX, e.clientY);
      this.clampPan();
      this.viewTick.update((n) => n + 1);
      return;
    }
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop' && this.crop.dragging) {
      const buf = this.session.current();
      this.crop.update(p, { w: buf?.width ?? 0, h: buf?.height ?? 0 }, this.cropAspect());
      return;
    }
    const dragging =
      (t === 'heal' && this.strokes.healActive) ||
      (t === 'liquify' && this.strokes.liquifyDragging) ||
      (t === 'clone' && this.strokes.cloneStrokeDragging) ||
      (t === 'retouch' && this.strokes.retouchDragging);
    if (dragging) {
      const cp = this.cursorPos();
      if (cp) this.strokeTrail.update((trail) => [...trail, cp]);
    }
    if (t === 'clone') this.strokes.dragClone(p, this.brushSize(), this.cloneStrength());
    if (t === 'retouch') {
      this.strokes.dragRetouch(p, this.brushSize(), this.retouchMode(), this.retouchStrength(), this.retouchFeather());
    }
    if (t === 'heal') this.strokes.dragHeal(p);
    if (t === 'liquify') this.strokes.dragLiquify(p, this.brushSize(), this.liquifyMode(), this.liquifyStrength());
  }

  private updateCursor(e: PointerEvent): void {
    const vp = this.vpRect();
    if (vp) this.cursorPos.set({ x: e.clientX - vp.left, y: e.clientY - vp.top });
    // Pointer events carry the live modifier state — catches Alt presses the
    // window key listeners miss (focus elsewhere, missed keyup).
    this.altHeld.set(e.altKey);
  }

  async onPointerUp(): Promise<void> {
    this.panZoom.endDrag();
    const t = this.tool();
    if (t === 'liquify' && this.strokes.liquifyStrokedFlag) {
      this.strokeTrail.set([]);
      await this.strokes.commitLiquify();
    }
    if (t === 'clone' && this.strokes.cloneStrokedFlag) {
      this.cloneDragging.set(false);
      this.strokeTrail.set([]);
      await this.strokes.commitClone();
    }
    if (t === 'retouch' && this.strokes.retouchStrokedFlag) {
      this.strokeTrail.set([]);
      await this.strokes.commitRetouch();
    }
    if (t === 'heal' && this.strokes.healActive) {
      await this.strokes.commitHeal(this.brushSize());
    }
    // A stray click (no real drag) leaves a zero-size box — restore the full box.
    const r = this.crop.rect();
    if (r && (r.width < MIN_CROP_PX || r.height < MIN_CROP_PX) && this.crop.dragMode === 'new') {
      this.initCropBox(this.cropAspect());
    }
    this.strokes.resetAll();
    this.crop.end();
    this.cloneDragging.set(false);
    this.strokeTrail.set([]);
  }

  onPointerLeave(): void {
    this.cursorPos.set(null);
    void this.onPointerUp();
  }

  async applyCrop(): Promise<void> {
    const r = this.crop.rect();
    if (!r || r.width < MIN_CROP_PX || r.height < MIN_CROP_PX) return;
    await this.session.apply('crop', {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    this.crop.clear();
  }

  cancelCrop(): void {
    this.initCropBox(this.cropAspect());
    this.crop.end();
  }
}
