import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { sampleBilinear } from './transform';

export interface PerspectiveParams {
  /** −100..100; positive stretches the top of the frame (fixes buildings
   * photographed from below, edges converging upward). */
  vertical: number;
  /** −100..100; positive stretches the left side. */
  horizontal: number;
}

/**
 * Keystone correction: the output frame samples a trapezoid inside the source,
 * so the result always fills the frame — no transparent corners, no crop step.
 */
export function perspective(buf: PixelBuffer, p: PerspectiveParams): PixelBuffer {
  if (p.vertical === 0 && p.horizontal === 0) return clonePixels(buf);
  const { width: w, height: h } = buf;
  const data = new Uint8ClampedArray(w * h * 4);
  const v = (Math.min(100, Math.max(-100, p.vertical)) / 100) * 0.3;
  const hz = (Math.min(100, Math.max(-100, p.horizontal)) / 100) * 0.3;
  for (let y = 0; y < h; y++) {
    const t = h > 1 ? y / (h - 1) : 0;
    // Rows near the stretched edge sample a narrower horizontal strip.
    const insetV = v > 0 ? v * (1 - t) : -v * t;
    const rowLeft = (insetV * w) / 2;
    const rowWidth = w - insetV * w;
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0;
      const insetH = hz > 0 ? hz * (1 - u) : -hz * u;
      const colTop = (insetH * h) / 2;
      const colHeight = h - insetH * h;
      const sx = rowLeft + u * (rowWidth - 1);
      const sy = colTop + t * (colHeight - 1);
      sampleBilinear(buf, sx, sy, data, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
