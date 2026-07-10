import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface LevelsParams {
  /** Input black point 0..254. */
  black: number;
  /** Input white point 1..255. */
  white: number;
  /** Midtone gamma 0.2..5; 1 = linear. */
  gamma: number;
}

/** Photoshop-style input levels: remap black/white points with a gamma curve. */
export function levels(buf: PixelBuffer, p: LevelsParams): PixelBuffer {
  if (p.black === 0 && p.white === 255 && Math.abs(p.gamma - 1) < 1e-3) return clonePixels(buf);
  const span = Math.max(1, p.white - p.black);
  const inv = 1 / Math.max(0.2, Math.min(5, p.gamma));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - p.black) / span));
    lut[v] = Math.pow(t, inv) * 255;
  }
  const out = clonePixels(buf);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return out;
}

/** 256-bin luminance histogram, normalized to 0..1 per bin — feeds the panel graph. */
export function lumaHistogram(buf: PixelBuffer): Float32Array {
  const bins = new Float32Array(256);
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    bins[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  }
  let max = 1;
  for (let v = 0; v < 256; v++) if (bins[v] > max) max = bins[v];
  for (let v = 0; v < 256; v++) bins[v] /= max;
  return bins;
}
