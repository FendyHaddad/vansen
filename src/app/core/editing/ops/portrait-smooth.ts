import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface PortraitSmoothParams {
  /** 0..100 — how much pore/blemish detail to soften. */
  strength: number;
}

/**
 * Frequency-separation skin smoothing: blur to the low band, attenuate only the
 * small-amplitude high-frequency detail on skin-tone pixels, keep edges/features.
 * No ML weights — fully commercial-clean. Alpha untouched.
 */
export function portraitSmooth(buf: PixelBuffer, p: PortraitSmoothParams): PixelBuffer {
  const mix = Math.min(100, Math.max(0, p.strength)) / 100;
  if (mix === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const radius = Math.max(1, Math.round(Math.min(w, h) / 200) + 1);
  const low = boxBlur(buf, radius);
  const out = clonePixels(buf);
  const d = out.data;
  const thresh = 18; // detail bigger than this is an edge/feature — preserve it

  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    const r = src[q];
    const g = src[q + 1];
    const b = src[q + 2];
    const isSkin = r > 60 && g > 40 && b > 20 && r >= g && g >= b && r - b > 8;
    for (let c = 0; c < 3; c++) {
      const hf = src[q + c] - low.data[q + c];
      const keep = !isSkin || Math.abs(hf) > thresh ? 1 : 1 - mix * 0.85;
      d[q + c] = low.data[q + c] + hf * keep;
    }
  }
  return out;
}

/** Two-pass separable box blur (near-gaussian), edges clamped. */
function boxBlur(buf: PixelBuffer, radius: number): PixelBuffer {
  let out = buf;
  for (let pass = 0; pass < 2; pass++) out = blurAxis(blurAxis(out, radius, true), radius, false);
  return out;
}

function blurAxis(buf: PixelBuffer, radius: number, horizontal: boolean): PixelBuffer {
  const { width: w, height: h } = buf;
  const out = clonePixels(buf);
  const src = buf.data;
  const dst = out.data;
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const lineStride = horizontal ? w * 4 : 4;
  const win = radius * 2 + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride + c];
      }
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + c] = sum / win;
        const add = Math.min(len - 1, i + radius + 1);
        const sub = Math.max(0, i - radius);
        sum += src[base + add * stride + c] - src[base + sub * stride + c];
      }
    }
  }
  return out;
}
