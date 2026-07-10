import { PixelBuffer } from '../pixel-buffer';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function crop(buf: PixelBuffer, r: CropRect): PixelBuffer {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(buf.width - x, Math.floor(r.width));
  const h = Math.min(buf.height - y, Math.floor(r.height));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * buf.width + x) * 4;
    data.set(buf.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/** Clockwise 90°: the input's left edge becomes the output's top edge. */
export function rotate90(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h } = buf;
  const data = new Uint8ClampedArray(buf.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (x * h + (h - 1 - y)) * 4;
      data.set(buf.data.subarray(src, src + 4), dst);
    }
  }
  return { width: h, height: w, data };
}
