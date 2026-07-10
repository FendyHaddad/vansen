import { PixelBuffer, clonePixels } from '../pixel-buffer';

/** 3×3 convolution, edge pixels clamped. Alpha untouched. */
function convolve3(buf: PixelBuffer, k: number[]): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = clonePixels(buf);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const sx = Math.min(w - 1, Math.max(0, x + kx));
            const sy = Math.min(h - 1, Math.max(0, y + ky));
            acc += src[(sy * w + sx) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
          }
        }
        d[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  return out;
}

/** Blend between identity and a full-strength kernel by amount 0..100. */
function blended(buf: PixelBuffer, kernel: number[], amount: number): PixelBuffer {
  if (amount <= 0) return clonePixels(buf);
  const full = convolve3(buf, kernel);
  if (amount >= 100) return full;
  const t = amount / 100;
  const out = clonePixels(buf);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = buf.data[i + c] * (1 - t) + full.data[i + c] * t;
    }
  }
  return out;
}

export function sharpen(buf: PixelBuffer, amount: number): PixelBuffer {
  return blended(buf, [0, -1, 0, -1, 5, -1, 0, -1, 0], amount);
}

export function smooth(buf: PixelBuffer, amount: number): PixelBuffer {
  const n = 1 / 9;
  return blended(buf, [n, n, n, n, n, n, n, n, n], amount);
}
