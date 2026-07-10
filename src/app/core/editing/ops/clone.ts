import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface CloneStep {
  /** Sample center in image px. */
  sx: number;
  sy: number;
  /** Stamp center in image px. */
  tx: number;
  ty: number;
  radius: number;
  /** 0..1 dab opacity; omitted = fully opaque. */
  strength?: number;
}

/**
 * One clone-stamp dab: copies a feathered circle from (sx,sy) onto (tx,ty).
 * Source pixels are read from the pre-dab buffer, so a single dab never
 * smears itself; successive dabs still see earlier ones (each op runs on the
 * accumulated stroke preview).
 */
export function cloneStamp(buf: PixelBuffer, s: CloneStep): PixelBuffer {
  const out = clonePixels(buf);
  const { width: w, height: h } = buf;
  const r = Math.max(1, s.radius);
  const x0 = Math.max(0, Math.floor(s.tx - r));
  const x1 = Math.min(w - 1, Math.ceil(s.tx + r));
  const y0 = Math.max(0, Math.floor(s.ty - r));
  const y1 = Math.min(h - 1, Math.ceil(s.ty + r));
  const src = buf.data;
  const dst = out.data;
  const opacity = Math.min(1, Math.max(0, s.strength ?? 1));
  if (opacity === 0) return out;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - s.tx, y - s.ty);
      if (dist > r) continue;
      // Solid center, soft falloff over the outer 35% of the radius.
      const t = dist / r;
      const a = (t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35) * opacity;
      const px = Math.round(s.sx + (x - s.tx));
      const py = Math.round(s.sy + (y - s.ty));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const si = (py * w + px) * 4;
      const di = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        dst[di + c] = src[si + c] * a + dst[di + c] * (1 - a);
      }
    }
  }
  return out;
}
