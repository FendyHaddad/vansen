import { resizeBilinear } from './engines/raster';
import { PixelBuffer } from './pixel-buffer';

/**
 * Downscaled copy of the committed pixels, memoized per commit so repeated
 * preview computations at the same `maxDim` (a slider drag) don't re-resize
 * on every frame. The cache is keyed on `cur.data`'s identity, which changes
 * on every commit, plus `maxDim` itself. Split out of `edit-session.ts` — a
 * pure memoization helper with no session state of its own.
 */
export class DownscaleCache {
  private cached: { src: Uint8ClampedArray; maxDim: number; buf: PixelBuffer } | null = null;

  /** `cur` resized so its long edge is `maxDim` — `cur` itself if already smaller. */
  get(cur: PixelBuffer, maxDim: number): PixelBuffer {
    const long = Math.max(cur.width, cur.height);
    if (long <= maxDim) return cur;
    if (this.cached?.src === cur.data && this.cached.maxDim === maxDim) {
      return this.cached.buf;
    }
    const k = maxDim / long;
    const buf = resizeBilinear(
      cur,
      Math.max(1, Math.round(cur.width * k)),
      Math.max(1, Math.round(cur.height * k)),
    );
    this.cached = { src: cur.data, maxDim, buf };
    return buf;
  }

  clear(): void {
    this.cached = null;
  }
}
