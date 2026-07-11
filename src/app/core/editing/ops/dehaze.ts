import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface DehazeParams {
  /** 0..100 — how aggressively to remove haze. */
  strength: number;
}

/** Single-image dehazing via the dark-channel prior (He et al.). Alpha untouched. */
export function dehaze(buf: PixelBuffer, p: DehazeParams): PixelBuffer {
  const mix = Math.min(100, Math.max(0, p.strength)) / 100;
  if (mix === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const n = w * h;

  // Per-pixel min over RGB, then a min-filter → the dark channel.
  const minRgb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    minRgb[i] = Math.min(src[q], src[q + 1], src[q + 2]);
  }
  const rad = Math.max(1, Math.round(Math.min(w, h) / 100));
  const dark = minFilter(minRgb, w, h, rad);

  // Atmospheric light: average source color over the brightest 0.1% of dark px.
  const A = atmosphere(src, dark, n);
  const aGray = Math.max(1, (A[0] + A[1] + A[2]) / 3);
  const omega = 0.95;

  const out = clonePixels(buf);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0.1, 1 - omega * (dark[i] / aGray));
    const q = i * 4;
    for (let c = 0; c < 3; c++) {
      const j = (src[q + c] - A[c]) / t + A[c];
      d[q + c] = src[q + c] + (j - src[q + c]) * mix;
    }
  }
  return out;
}

/** Separable min over a (2r+1) window, edges clamped. */
function minFilter(m: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = Infinity;
      for (let k = -r; k <= r; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k));
        v = Math.min(v, m[y * w + sx]);
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = Infinity;
      for (let k = -r; k <= r; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        v = Math.min(v, tmp[sy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function atmosphere(
  src: ArrayLike<number>,
  dark: Float32Array,
  n: number,
): [number, number, number] {
  const count = Math.max(1, Math.floor(n * 0.001));
  // Indices of the `count` largest dark-channel values.
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => dark[b] - dark[a])
    .slice(0, count);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of idx) {
    const q = i * 4;
    r += src[q];
    g += src[q + 1];
    b += src[q + 2];
  }
  return [r / count, g / count, b / count];
}
