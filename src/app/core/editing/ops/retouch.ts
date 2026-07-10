import { PixelBuffer, clonePixels } from '../pixel-buffer';

export type RetouchMode = 'lighten' | 'darken' | 'saturate' | 'desaturate';

export interface RetouchStep {
  cx: number;
  cy: number;
  radius: number;
  mode: RetouchMode;
  /** 0..1 effect applied by this single dab — strokes build up gradually. */
  strength: number;
  /** 0..1 edge softness: 0 = hard-edged disc, 1 = falloff from the center.
   * Omitted = 0.5 (the original fixed behavior). */
  feather?: number;
}

/** One feathered dodge/burn/saturation dab. */
export function retouch(buf: PixelBuffer, s: RetouchStep): PixelBuffer {
  const out = clonePixels(buf);
  const { width: w, height: h } = buf;
  const r = Math.max(1, s.radius);
  const x0 = Math.max(0, Math.floor(s.cx - r));
  const x1 = Math.min(w - 1, Math.ceil(s.cx + r));
  const y0 = Math.max(0, Math.floor(s.cy - r));
  const y1 = Math.min(h - 1, Math.ceil(s.cy + r));
  const d = out.data;
  // Solid core out to (1 − feather) of the radius, linear falloff beyond.
  const core = 1 - Math.min(0.98, Math.max(0, s.feather ?? 0.5));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - s.cx, y - s.cy);
      if (dist > r) continue;
      const t = dist / r;
      const feather = t < core ? 1 : 1 - (t - core) / (1 - core);
      const f = feather * s.strength;
      const i = (y * w + x) * 4;
      const pr = d[i];
      const pg = d[i + 1];
      const pb = d[i + 2];
      switch (s.mode) {
        case 'lighten':
          d[i] = pr + (255 - pr) * 0.2 * f;
          d[i + 1] = pg + (255 - pg) * 0.2 * f;
          d[i + 2] = pb + (255 - pb) * 0.2 * f;
          break;
        case 'darken':
          d[i] = pr * (1 - 0.2 * f);
          d[i + 1] = pg * (1 - 0.2 * f);
          d[i + 2] = pb * (1 - 0.2 * f);
          break;
        case 'saturate':
        case 'desaturate': {
          const gray = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
          const k = s.mode === 'saturate' ? 1 + 0.5 * f : 1 - 0.7 * f;
          d[i] = gray + (pr - gray) * k;
          d[i + 1] = gray + (pg - gray) * k;
          d[i + 2] = gray + (pb - gray) * k;
          break;
        }
      }
    }
  }
  return out;
}
