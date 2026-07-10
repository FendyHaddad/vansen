import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface LiquifyStep {
  /** Brush center in pixels. */
  cx: number;
  cy: number;
  radius: number;
  /** Drag vector for this step, pixels. */
  dx: number;
  dy: number;
}

/**
 * One push-brush step: pixels within radius sample backward along the drag
 * vector, faded by a smooth falloff — the classic warp Photoshop's forward
 * warp tool applies per pointer move. Bilinear sampling keeps edges smooth.
 */
export function liquify(buf: PixelBuffer, s: LiquifyStep): PixelBuffer {
  if (s.dx === 0 && s.dy === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const out = clonePixels(buf);
  const r2 = s.radius * s.radius;
  const x0 = Math.max(0, Math.floor(s.cx - s.radius));
  const x1 = Math.min(w - 1, Math.ceil(s.cx + s.radius));
  const y0 = Math.max(0, Math.floor(s.cy - s.radius));
  const y1 = Math.min(h - 1, Math.ceil(s.cy + s.radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist2 = (x - s.cx) ** 2 + (y - s.cy) ** 2;
      if (dist2 >= r2) continue;
      const falloff = (1 - dist2 / r2) ** 2;
      const sx = Math.min(w - 1, Math.max(0, x - s.dx * falloff));
      const sy = Math.min(h - 1, Math.max(0, y - s.dy * falloff));
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
