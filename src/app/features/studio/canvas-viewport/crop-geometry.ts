import { signal } from '@angular/core';
import { CropRect } from '../../../core/editing/ops/crop';
import { clamp } from './viewport-math';

/**
 * Crop-tool gesture state and math, moved out of CanvasViewport verbatim.
 * `resolveCropDrag` is pure (image-pixel geometry only); `CropGesture` is the
 * small stateful wrapper the component drives from its pointer handlers.
 */

/** Crop drag intent: draw a new box, move it, or resize from an edge/corner. */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type CropMode = 'new' | 'move' | CropHandle;

export const MIN_CROP_PX = 8;

/** Largest centered box for the ratio (whole image when free-form). */
export function initialCropRect(bufWidth: number, bufHeight: number, aspect: number | null): CropRect {
  let w = bufWidth;
  let h = bufHeight;
  if (aspect) {
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
  }
  return { x: (bufWidth - w) / 2, y: (bufHeight - h) / 2, width: w, height: h };
}

/** Apply a drag delta to the start rectangle per gesture mode, clamped to the image. */
export function resolveCropDrag(
  drag: { mode: CropMode; startPt: { x: number; y: number }; startRect: CropRect },
  p: { x: number; y: number },
  bounds: { w: number; h: number },
  aspect: number | null,
): CropRect {
  const w = bounds.w;
  const h = bounds.h;
  const a = aspect;
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

/** Crop-box state machine: current rect plus the in-flight drag, if any. */
export class CropGesture {
  readonly rect = signal<CropRect | null>(null);
  private drag: { mode: CropMode; startPt: { x: number; y: number }; startRect: CropRect } | null = null;

  get dragging(): boolean {
    return this.drag !== null;
  }

  get dragMode(): CropMode | null {
    return this.drag?.mode ?? null;
  }

  /** Largest centered box for the ratio, or null while there is no image. */
  initBox(buf: { width: number; height: number } | null, aspect: number | null): void {
    if (!buf) {
      this.rect.set(null);
      return;
    }
    this.rect.set(initialCropRect(buf.width, buf.height, aspect));
  }

  /** Click on empty canvas: start drawing a fresh box from this point. */
  beginNew(p: { x: number; y: number }): void {
    this.drag = { mode: 'new', startPt: p, startRect: { x: p.x, y: p.y, width: 0, height: 0 } };
    this.rect.set({ x: p.x, y: p.y, width: 0, height: 0 });
  }

  /** Begin a move/resize gesture from a crop handle or the box body. */
  beginHandleDrag(mode: 'move' | CropHandle, p: { x: number; y: number }): boolean {
    const r = this.rect();
    if (!r) return false;
    this.drag = { mode, startPt: p, startRect: { ...r } };
    return true;
  }

  update(p: { x: number; y: number }, bounds: { w: number; h: number }, aspect: number | null): void {
    if (!this.drag) return;
    this.rect.set(resolveCropDrag(this.drag, p, bounds, aspect));
  }

  end(): void {
    this.drag = null;
  }

  clear(): void {
    this.rect.set(null);
  }
}
