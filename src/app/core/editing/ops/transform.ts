import { PixelBuffer, clonePixels } from '../pixel-buffer';

export type FlipAxis = 'h' | 'v';

/** Counter-clockwise 90°: the input's right edge becomes the output's top edge. */
export function rotate90ccw(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h } = buf;
  const data = new Uint8ClampedArray(buf.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = ((w - 1 - x) * h + y) * 4;
      data.set(buf.data.subarray(src, src + 4), dst);
    }
  }
  return { width: h, height: w, data };
}

export function flip(buf: PixelBuffer, axis: FlipAxis): PixelBuffer {
  const { width: w, height: h } = buf;
  const data = new Uint8ClampedArray(buf.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = axis === 'h' ? w - 1 - x : x;
      const sy = axis === 'v' ? h - 1 - y : y;
      const src = (sy * w + sx) * 4;
      data.set(buf.data.subarray(src, src + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

export interface StraightenParams {
  /** −45..45; positive tilts the content clockwise. */
  degrees: number;
  /** True crops to the largest inside rectangle; false keeps the frame
   * (corners fill dark) — the live-preview shape. */
  crop: boolean;
}

export function straighten(buf: PixelBuffer, p: StraightenParams): PixelBuffer {
  const a = (p.degrees * Math.PI) / 180;
  if (Math.abs(a) < 1e-4) return clonePixels(buf);
  const { width: w, height: h } = buf;
  const size = p.crop ? maxInscribed(w, h, a) : { width: w, height: h };
  const ow = Math.max(1, Math.floor(size.width));
  const oh = Math.max(1, Math.floor(size.height));
  const data = new Uint8ClampedArray(ow * oh * 4);
  if (!p.crop) {
    // Opaque dark corners — transparent would show the unrotated image behind
    // the preview overlay.
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 13;
      data[i + 1] = 13;
      data[i + 2] = 16;
      data[i + 3] = 255;
    }
  }
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  const ocx = ow / 2;
  const ocy = oh / 2;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const dx = x + 0.5 - ocx;
      const dy = y + 0.5 - ocy;
      const sx = cx + dx * cos - dy * sin - 0.5;
      const sy = cy + dx * sin + dy * cos - 0.5;
      sampleBilinear(buf, sx, sy, data, (y * ow + x) * 4);
    }
  }
  return { width: ow, height: oh, data };
}

/**
 * Bilinear sample of buf at (x,y) into out[o..o+3]. Leaves out untouched when
 * the point falls fully outside the source.
 */
export function sampleBilinear(
  buf: PixelBuffer,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  o: number,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < -1 || y0 < -1 || x0 > buf.width - 1 || y0 > buf.height - 1) return;
  const x1 = Math.min(buf.width - 1, x0 + 1);
  const y1 = Math.min(buf.height - 1, y0 + 1);
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const fx = x - x0;
  const fy = y - y0;
  const d = buf.data;
  const i00 = (cy0 * buf.width + cx0) * 4;
  const i10 = (cy0 * buf.width + x1) * 4;
  const i01 = (y1 * buf.width + cx0) * 4;
  const i11 = (y1 * buf.width + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
    const bot = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[o + c] = top * (1 - fy) + bot * fy;
  }
}

/** Largest axis-aligned rectangle that fits inside a w×h frame rotated by angle. */
function maxInscribed(w: number, h: number, angle: number): { width: number; height: number } {
  const sinA = Math.abs(Math.sin(angle));
  const cosA = Math.abs(Math.cos(angle));
  const sideLong = Math.max(w, h);
  const sideShort = Math.min(w, h);
  if (sideShort <= 2 * sinA * cosA * sideLong || Math.abs(sinA - cosA) < 1e-10) {
    const half = 0.5 * sideShort;
    return w >= h
      ? { width: half / sinA, height: half / cosA }
      : { width: half / cosA, height: half / sinA };
  }
  const cos2A = cosA * cosA - sinA * sinA;
  return {
    width: (w * cosA - h * sinA) / cos2A,
    height: (h * cosA - w * sinA) / cos2A,
  };
}
