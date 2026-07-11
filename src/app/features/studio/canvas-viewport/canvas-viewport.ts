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
import { CropRect } from '../../../core/editing/ops/crop';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';
import { MaskCanvas } from '../mask-canvas/mask-canvas';
import { DRAG_TOOLS, StudioTool } from '../studio-tool';

/** Crop drag intent: draw a new box, move it, or resize from an edge/corner. */
type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type CropMode = 'new' | 'move' | CropHandle;

const MIN_CROP_PX = 8;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Center stage in edit mode: the working image + paintable mask overlay. */
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

  /** Crop rectangle in image pixels, null = none. */
  readonly cropRect = signal<CropRect | null>(null);
  /** Bumped on resize/layout so screen-space computeds re-measure the DOM. */
  private readonly viewTick = signal(0);
  /** Pointer position relative to the viewport, for the brush cursor ring. */
  readonly cursorPos = signal<{ x: number; y: number } | null>(null);
  /** View offset in CSS px while zoomed in — wheel/trackpad pans the image. */
  private readonly panSig = signal({ x: 0, y: 0 });
  /** Active click-drag pan gesture (mouse users), null = none. */
  private readonly panDrag = signal<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null);

  /** Grab cursor: zoomed in and the active tool leaves left-drag free. */
  readonly pannable = computed(() => {
    if (this.session.zoom() <= 1) return false;
    const t = this.tool();
    return t === null || !DRAG_TOOLS.has(t);
  });
  readonly panning = computed(() => this.panDrag() !== null);

  /** Zoom + pan applied to the stage. Overlay math needs no special casing —
   * it measures the transformed DOM rects. */
  readonly stageTransform = computed(() => {
    const z = this.session.zoom();
    const p = this.panSig();
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
    const r = this.cropRect();
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
    const r = this.cropRect();
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

  private cropDrag: { mode: CropMode; startPt: { x: number; y: number }; startRect: CropRect } | null = null;
  private healStroke: { x: number; y: number }[] = [];
  private liquifyLast: { x: number; y: number } | null = null;
  /** True once the current liquify drag posted a step — commit on release. */
  private liquifyStroked = false;
  /** Steps queued but not yet rendered — backpressure for fast drags. */
  private liquifyPending = 0;
  /** Fixed source − stroke-start offset while a clone drag is active. */
  private cloneOffset: { x: number; y: number } | null = null;
  private cloneLast: { x: number; y: number } | null = null;
  private cloneStroked = false;
  private clonePending = 0;
  private retouchLast: { x: number; y: number } | null = null;
  private retouchStroked = false;
  private retouchPending = 0;

  constructor() {
    // Entering crop shows a ready-made centered box; preset changes re-fit it.
    effect(() => {
      const t = this.tool();
      const aspect = this.cropAspect();
      this.session.previewUrl(); // re-init after loads / rotations change dims
      if (t === 'crop') this.initCropBox(aspect);
      else this.cropRect.set(null);
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
      if (z <= 1) this.panSig.set({ x: 0, y: 0 });
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
      this.panSig.set({ x: 0, y: 0 });
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
    this.panSig.update((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    this.clampPan();
    this.viewTick.update((n) => n + 1);
  }

  /** The image is centered; panning may shift it at most until the far edge
   * reaches the viewport edge (no gap can open on the opposite side). */
  private clampPan(): void {
    const img = this.imgRect();
    const vp = this.vpRect();
    if (!img || !vp) return;
    const maxX = Math.max(0, (img.width - vp.width) / 2);
    const maxY = Math.max(0, (img.height - vp.height) / 2);
    this.panSig.update((p) => {
      const x = clamp(p.x, -maxX, maxX);
      const y = clamp(p.y, -maxY, maxY);
      return x === p.x && y === p.y ? p : { x, y };
    });
  }

  /** Largest centered box for the ratio (whole image when free-form). */
  private initCropBox(aspect: number | null): void {
    const buf = this.session.current();
    if (!buf) {
      this.cropRect.set(null);
      return;
    }
    let w = buf.width;
    let h = buf.height;
    if (aspect) {
      if (w / h > aspect) w = h * aspect;
      else h = w / aspect;
    }
    this.cropRect.set({ x: (buf.width - w) / 2, y: (buf.height - h) / 2, width: w, height: h });
    // The <img> may not be laid out yet — re-measure once it is.
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
    const r = this.cropRect();
    if (!p || !r) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.cropDrag = { mode, startPt: p, startRect: { ...r } };
  }

  onPointerDown(e: PointerEvent): void {
    this.updateCursor(e);
    // Click-drag pan for mouse users: free left-drag, or middle-drag with any tool.
    if (this.session.zoom() > 1 && (e.button === 1 || (e.button === 0 && this.pannable()))) {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.panDrag.set({ startX: e.clientX, startY: e.clientY, origin: this.panSig() });
      return;
    }
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop') {
      // Click on empty canvas draws a fresh box.
      this.cropDrag = { mode: 'new', startPt: p, startRect: { x: p.x, y: p.y, width: 0, height: 0 } };
      this.cropRect.set({ x: p.x, y: p.y, width: 0, height: 0 });
    }
    if (t === 'heal' || t === 'liquify' || t === 'clone' || t === 'retouch') {
      const cp = this.cursorPos();
      this.strokeTrail.set(cp ? [cp] : []);
    }
    if (t === 'heal') this.healStroke = [p];
    if (t === 'liquify') {
      this.liquifyLast = p;
      // Pinch/bulge act on click too — no drag needed to see the effect.
      if (this.liquifyMode() !== 'push') {
        this.postLiquifyStep({ cx: p.x, cy: p.y, dx: 0, dy: 0 });
      }
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
      this.cloneOffset = { x: src.x - p.x, y: src.y - p.y };
      this.cloneLast = p;
      this.cloneDragging.set(true);
      this.postCloneStamp(p);
    }
    if (t === 'retouch' && e.button === 0) {
      this.retouchLast = p;
      this.postRetouchDab(p);
    }
    // Point-pick tools: bokeh focus, smart select, magic erase. Tool options react.
    if ((t === 'bokeh' || t === 'select' || t === 'erase') && e.button === 0) {
      this.session.setPointPick(p);
    }
  }

  private postCloneStamp(q: { x: number; y: number }): void {
    const off = this.cloneOffset;
    if (!off) return;
    this.cloneStroked = true;
    this.clonePending++;
    void this.session
      .strokeOp('clone', {
        sx: q.x + off.x,
        sy: q.y + off.y,
        tx: q.x,
        ty: q.y,
        radius: this.brushSize(),
        strength: this.cloneStrength() / 100,
      })
      .finally(() => this.clonePending--);
  }

  private postRetouchDab(q: { x: number; y: number }): void {
    this.retouchStroked = true;
    this.retouchPending++;
    void this.session
      .strokeOp('retouch', {
        cx: q.x,
        cy: q.y,
        radius: this.brushSize(),
        mode: this.retouchMode(),
        // Half-scaled per dab so a slow pass builds up instead of slamming.
        strength: (this.retouchStrength() / 100) * 0.5,
        feather: this.retouchFeather() / 100,
      })
      .finally(() => this.retouchPending--);
  }

  /** Preview-only liquify step: instant feedback, one undo entry per stroke. */
  private postLiquifyStep(step: { cx: number; cy: number; dx: number; dy: number }): void {
    this.liquifyStroked = true;
    this.liquifyPending++;
    void this.session
      .strokeOp('liquify', {
        ...step,
        radius: this.brushSize(),
        mode: this.liquifyMode(),
        strength: this.liquifyStrength() / 100,
      })
      .finally(() => this.liquifyPending--);
  }

  onPointerMove(e: PointerEvent): void {
    this.updateCursor(e);
    const drag = this.panDrag();
    if (drag) {
      this.panSig.set({
        x: drag.origin.x + e.clientX - drag.startX,
        y: drag.origin.y + e.clientY - drag.startY,
      });
      this.clampPan();
      this.viewTick.update((n) => n + 1);
      return;
    }
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop' && this.cropDrag) {
      this.cropRect.set(this.resolveCrop(this.cropDrag, p));
      return;
    }
    const dragging =
      (t === 'heal' && this.healStroke.length > 0) ||
      (t === 'liquify' && !!this.liquifyLast) ||
      (t === 'clone' && !!this.cloneLast) ||
      (t === 'retouch' && !!this.retouchLast);
    if (dragging) {
      const cp = this.cursorPos();
      if (cp) this.strokeTrail.update((trail) => [...trail, cp]);
    }
    if (t === 'clone' && this.cloneLast) {
      if (this.clonePending > 2) return;
      this.stampAlong(this.cloneLast, p, this.brushSize() * 0.35, (q) => this.postCloneStamp(q));
      this.cloneLast = p;
    }
    if (t === 'retouch' && this.retouchLast) {
      if (this.retouchPending > 2) return;
      this.stampAlong(this.retouchLast, p, this.brushSize() * 0.4, (q) => this.postRetouchDab(q));
      this.retouchLast = p;
    }
    if (t === 'heal' && this.healStroke.length) this.healStroke.push(p);
    if (t === 'liquify' && this.liquifyLast) {
      // Backpressure: if the worker is behind, let displacement accumulate
      // into the next event instead of queueing an ever-growing backlog.
      if (this.liquifyPending > 2) return;
      const dx = p.x - this.liquifyLast.x;
      const dy = p.y - this.liquifyLast.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      // Split fast pointer jumps into capped sub-steps along the segment —
      // one violent step was the "jitter"; several gentle ones read smooth.
      const maxStep = this.brushSize() * 0.35;
      const n = Math.min(4, Math.max(1, Math.ceil(len / maxStep)));
      const sx = dx / n;
      const sy = dy / n;
      const sLen = Math.hypot(sx, sy);
      const k = sLen > maxStep ? maxStep / sLen : 1;
      for (let i = 0; i < n; i++) {
        this.postLiquifyStep({
          cx: this.liquifyLast.x + sx * i,
          cy: this.liquifyLast.y + sy * i,
          dx: sx * k,
          dy: sy * k,
        });
      }
      this.liquifyLast = p;
    }
  }

  /** Evenly spaced dabs from a (exclusive) to b (inclusive), capped per event. */
  private stampAlong(
    a: { x: number; y: number },
    b: { x: number; y: number },
    spacing: number,
    dab: (q: { x: number; y: number }) => void,
  ): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) return;
    const n = Math.min(6, Math.max(1, Math.round(len / Math.max(2, spacing))));
    for (let i = 1; i <= n; i++) {
      dab({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
    }
  }

  private updateCursor(e: PointerEvent): void {
    const vp = this.vpRect();
    if (vp) this.cursorPos.set({ x: e.clientX - vp.left, y: e.clientY - vp.top });
    // Pointer events carry the live modifier state — catches Alt presses the
    // window key listeners miss (focus elsewhere, missed keyup).
    this.altHeld.set(e.altKey);
  }

  /** Apply a drag delta to the start rectangle per gesture mode, clamped to the image. */
  private resolveCrop(
    drag: { mode: CropMode; startPt: { x: number; y: number }; startRect: CropRect },
    p: { x: number; y: number },
  ): CropRect {
    const buf = this.session.current();
    const w = buf?.width ?? 0;
    const h = buf?.height ?? 0;
    const a = this.cropAspect();
    const dx = p.x - drag.startPt.x;
    const dy = p.y - drag.startPt.y;
    const s = drag.startRect;

    if (drag.mode === 'new') {
      if (a) {
        // Ratio-locked draw: dominant axis wins, scale to fit the image.
        const sx = p.x >= drag.startPt.x ? 1 : -1;
        const sy = p.y >= drag.startPt.y ? 1 : -1;
        let rw = Math.abs(dx);
        let rh = rw / a;
        if (Math.abs(dy) > rh) {
          rh = Math.abs(dy);
          rw = rh * a;
        }
        const maxW = sx > 0 ? w - drag.startPt.x : drag.startPt.x;
        const maxH = sy > 0 ? h - drag.startPt.y : drag.startPt.y;
        const k = Math.min(1, maxW / Math.max(rw, 1e-6), maxH / Math.max(rh, 1e-6));
        rw *= k;
        rh *= k;
        return {
          x: sx > 0 ? drag.startPt.x : drag.startPt.x - rw,
          y: sy > 0 ? drag.startPt.y : drag.startPt.y - rh,
          width: rw,
          height: rh,
        };
      }
      return {
        x: Math.min(drag.startPt.x, p.x),
        y: Math.min(drag.startPt.y, p.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
    }
    if (drag.mode === 'move') {
      return {
        x: clamp(s.x + dx, 0, w - s.width),
        y: clamp(s.y + dy, 0, h - s.height),
        width: s.width,
        height: s.height,
      };
    }
    // Edge/corner resize: move only the touched sides.
    let left = s.x;
    let top = s.y;
    let right = s.x + s.width;
    let bottom = s.y + s.height;
    if (drag.mode.includes('w')) left = clamp(s.x + dx, 0, right - MIN_CROP_PX);
    if (drag.mode.includes('e')) right = clamp(s.x + s.width + dx, left + MIN_CROP_PX, w);
    if (drag.mode.includes('n')) top = clamp(s.y + dy, 0, bottom - MIN_CROP_PX);
    if (drag.mode.includes('s')) bottom = clamp(s.y + s.height + dy, top + MIN_CROP_PX, h);

    if (a) {
      const m = drag.mode;
      if (m === 'e' || m === 'w') {
        // Width drives height, anchored at the vertical center.
        const cy = s.y + s.height / 2;
        let nw = right - left;
        let nh = nw / a;
        const maxH = 2 * Math.min(cy, h - cy);
        if (nh > maxH) {
          nh = maxH;
          nw = nh * a;
        }
        if (m === 'w') left = right - nw;
        else right = left + nw;
        top = cy - nh / 2;
        bottom = cy + nh / 2;
      } else if (m === 'n' || m === 's') {
        // Height drives width, anchored at the horizontal center.
        const cx = s.x + s.width / 2;
        let nh = bottom - top;
        let nw = nh * a;
        const maxW = 2 * Math.min(cx, w - cx);
        if (nw > maxW) {
          nw = maxW;
          nh = nw / a;
        }
        if (m === 'n') top = bottom - nh;
        else bottom = top + nh;
        left = cx - nw / 2;
        right = cx + nw / 2;
      } else {
        // Corners: the opposite corner stays fixed.
        const ax = m.includes('w') ? s.x + s.width : s.x;
        const ay = m.includes('n') ? s.y + s.height : s.y;
        let nw = m.includes('w') ? ax - left : right - ax;
        let nh = nw / a;
        const maxW = m.includes('w') ? ax : w - ax;
        const maxH = m.includes('n') ? ay : h - ay;
        if (nw > maxW) {
          nw = maxW;
          nh = nw / a;
        }
        if (nh > maxH) {
          nh = maxH;
          nw = nh * a;
        }
        left = m.includes('w') ? ax - nw : ax;
        right = left + nw;
        top = m.includes('n') ? ay - nh : ay;
        bottom = top + nh;
      }
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  async onPointerUp(): Promise<void> {
    this.panDrag.set(null);
    const t = this.tool();
    if (t === 'liquify' && this.liquifyStroked) {
      this.liquifyStroked = false;
      this.liquifyLast = null;
      this.strokeTrail.set([]);
      await this.session.commitStroke();
    }
    if (t === 'clone' && this.cloneStroked) {
      this.cloneStroked = false;
      this.cloneOffset = null;
      this.cloneLast = null;
      this.cloneDragging.set(false);
      this.strokeTrail.set([]);
      await this.session.commitStroke();
    }
    if (t === 'retouch' && this.retouchStroked) {
      this.retouchStroked = false;
      this.retouchLast = null;
      this.strokeTrail.set([]);
      await this.session.commitStroke();
    }
    if (t === 'heal' && this.healStroke.length) {
      const buf = this.session.current();
      if (buf) {
        const mask = new Uint8Array(buf.width * buf.height);
        for (const pt of this.healStroke) {
          stampCircle(mask, buf.width, buf.height, pt, this.brushSize());
        }
        this.healStroke = [];
        await this.session.applyHeal(mask);
      }
    }
    // A stray click (no real drag) leaves a zero-size box — restore the full box.
    const r = this.cropRect();
    if (r && (r.width < MIN_CROP_PX || r.height < MIN_CROP_PX) && this.cropDrag?.mode === 'new') {
      this.initCropBox(this.cropAspect());
    }
    this.healStroke = [];
    this.cropDrag = null;
    this.liquifyLast = null;
    this.cloneOffset = null;
    this.cloneLast = null;
    this.cloneDragging.set(false);
    this.retouchLast = null;
    this.strokeTrail.set([]);
  }

  onPointerLeave(): void {
    this.cursorPos.set(null);
    void this.onPointerUp();
  }

  async applyCrop(): Promise<void> {
    const r = this.cropRect();
    if (!r || r.width < MIN_CROP_PX || r.height < MIN_CROP_PX) return;
    await this.session.apply('crop', {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    this.cropRect.set(null);
  }

  cancelCrop(): void {
    this.initCropBox(this.cropAspect());
    this.cropDrag = null;
  }
}

function stampCircle(
  mask: Uint8Array,
  w: number,
  h: number,
  p: { x: number; y: number },
  radius: number,
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(p.x - radius));
  const x1 = Math.min(w - 1, Math.ceil(p.x + radius));
  const y0 = Math.max(0, Math.floor(p.y - radius));
  const y1 = Math.min(h - 1, Math.ceil(p.y + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r2) mask[y * w + x] = 255;
    }
  }
}
