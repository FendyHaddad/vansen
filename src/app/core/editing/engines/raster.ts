import { PixelBuffer } from '../pixel-buffer';

/** Shared pixel-math helpers for the ONNX engines. DOM-free. */

export function resizeBilinear(buf: PixelBuffer, dw: number, dh: number): PixelBuffer {
  if (dw === buf.width && dh === buf.height) {
    return { width: dw, height: dh, data: new Uint8ClampedArray(buf.data) };
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  const { width: sw, height: sh, data: s } = buf;
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * yr - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * xr - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = s[i00 + c] * (1 - fx) + s[i10 + c] * fx;
        const bot = s[i01 + c] * (1 - fx) + s[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** RGBA buffer → planar RGB float32 [3, h, w] with (v/255 − mean) / std per channel. */
export function toPlanarFloat(buf: PixelBuffer, mean: number[], std: number[]): Float32Array {
  const n = buf.width * buf.height;
  const out = new Float32Array(3 * n);
  const d = buf.data;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i] = (d[p] / 255 - mean[0]) / std[0];
    out[n + i] = (d[p + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (d[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Bilinear resize of a single-channel float map. */
export function resizeFloatMap(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  if (sw === dw && sh === dh) return new Float32Array(src);
  const out = new Float32Array(dw * dh);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * yr - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * xr - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
      const bot = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
      out[y * dw + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/** Grow a 0/255 mask by `radius` px (chebyshev) — AI inpainting wants a
 * margin around the object so no rim of original pixels survives. */
export function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  // Two separable passes (horizontal then vertical) keep it O(w*h*r).
  const pass = (src: Uint8Array, stepX: number, stepY: number): Uint8Array => {
    const out = new Uint8Array(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!src[y * w + x]) continue;
        for (let d = -radius; d <= radius; d++) {
          const nx = x + stepX * d;
          const ny = y + stepY * d;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) out[ny * w + nx] = 255;
        }
      }
    }
    return out;
  };
  return pass(pass(mask, 1, 0), 0, 1);
}

/** float32 → float16 bit conversion (for fp16-only model inputs). */
export function toFloat16Bits(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = ((x >>> 23) & 0xff) - 127 + 15;
    let mant = (x >>> 13) & 0x3ff;
    if (exp <= 0) {
      exp = 0;
      mant = 0; // flush denormals — model inputs never need them
    } else if (exp >= 31) {
      exp = 31;
      mant = 0;
    }
    out[i] = sign | (exp << 10) | mant;
  }
  return out;
}

/** float16 bits → float32. */
export function fromFloat16Bits(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i];
    const sign = (h & 0x8000) << 16;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    let bits: number;
    if (exp === 0) {
      bits = sign; // treat subnormals as zero
    } else if (exp === 31) {
      bits = sign | 0x7f800000 | (mant << 13);
    } else {
      bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    const u32 = new Uint32Array([bits]);
    out[i] = new Float32Array(u32.buffer)[0];
  }
  return out;
}
