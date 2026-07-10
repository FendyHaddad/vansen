import { PixelBuffer, clonePixels } from '../pixel-buffer';

export type LiquifyMode = 'push' | 'pinch' | 'bulge';

export interface LiquifyStep {
  /** Brush center in pixels. */
  cx: number;
  cy: number;
  radius: number;
  /** Drag vector for this step, pixels. */
  dx: number;
  dy: number;
  /** push = forward warp, pinch = slim toward center, bulge = expand. Default push. */
  mode?: LiquifyMode;
  /** 0..1 displacement scale; default 1 (full). */
  strength?: number;
}

/**
 * One liquify brush step, Photoshop-style. Push samples backward along the
 * drag vector (forward warp); pinch samples away from the center (content
 * shrinks — the "slim" tool); bulge samples toward the center (content
 * magnifies). All fade with a smooth falloff and use bilinear sampling.
 */
export function liquify(buf: PixelBuffer, s: LiquifyStep): PixelBuffer {
  const mode = s.mode ?? 'push';
  const strength = s.strength ?? 1;
  if (mode === 'push' && s.dx === 0 && s.dy === 0) return clonePixels(buf);
  if (strength <= 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const out = clonePixels(buf);
  const r2 = s.radius * s.radius;
  // Pinch/bulge scale per step — small so holding/dragging builds up gently.
  const radial = 0.12 * strength;
  const x0 = Math.max(0, Math.floor(s.cx - s.radius));
  const x1 = Math.min(w - 1, Math.ceil(s.cx + s.radius));
  const y0 = Math.max(0, Math.floor(s.cy - s.radius));
  const y1 = Math.min(h - 1, Math.ceil(s.cy + s.radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const rx = x - s.cx;
      const ry = y - s.cy;
      const dist2 = rx * rx + ry * ry;
      if (dist2 >= r2) continue;
      const falloff = (1 - dist2 / r2) ** 2;
      let sx: number;
      let sy: number;
      if (mode === 'push') {
        sx = x - s.dx * falloff * strength;
        sy = y - s.dy * falloff * strength;
      } else if (mode === 'pinch') {
        // Sample outward → pixels collapse toward the center (slims).
        sx = x + rx * radial * falloff;
        sy = y + ry * radial * falloff;
      } else {
        // Sample inward → center content spreads outward (bulges).
        sx = x - rx * radial * falloff;
        sy = y - ry * radial * falloff;
      }
      sx = Math.min(w - 1, Math.max(0, sx));
      sy = Math.min(h - 1, Math.max(0, sy));
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const ix1 = Math.min(w - 1, ix + 1);
      const iy1 = Math.min(h - 1, iy + 1);
      const di = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(iy * w + ix) * 4 + c];
        const p10 = src[(iy * w + ix1) * 4 + c];
        const p01 = src[(iy1 * w + ix) * 4 + c];
        const p11 = src[(iy1 * w + ix1) * 4 + c];
        out.data[di + c] =
          p00 * (1 - fx) * (1 - fy) +
          p10 * fx * (1 - fy) +
          p01 * (1 - fx) * fy +
          p11 * fx * fy;
      }
    }
  }
  return out;
}
