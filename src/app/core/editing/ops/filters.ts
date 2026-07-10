import { PixelBuffer, clonePixels } from '../pixel-buffer';

export type FilterPreset = 'bw' | 'sepia' | 'vintage' | 'warm' | 'cool' | 'grain' | 'vignette';

export interface FilterParams {
  preset: FilterPreset;
  /** 0..100 — blends the untouched pixels toward the full effect. */
  intensity: number;
}

/** One-look color filters. Alpha is never touched. */
export function filter(buf: PixelBuffer, p: FilterParams): PixelBuffer {
  const mix = Math.min(100, Math.max(0, p.intensity)) / 100;
  if (mix === 0) return clonePixels(buf);
  const out = clonePixels(buf);
  const d = out.data;
  const { width: w, height: h } = buf;
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  // Seeded so grain is identical between the live preview and Apply.
  const rand = mulberry32(0x9e3779b9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      let nr = r;
      let ng = g;
      let nb = b;
      switch (p.preset) {
        case 'bw': {
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const v = (gray - 128) * 1.08 + 128;
          nr = ng = nb = v;
          break;
        }
        case 'sepia':
          nr = 0.393 * r + 0.769 * g + 0.189 * b;
          ng = 0.349 * r + 0.686 * g + 0.168 * b;
          nb = 0.272 * r + 0.534 * g + 0.131 * b;
          break;
        case 'vintage': {
          // Faded blacks, gentle desaturation, warm shift, soft vignette.
          let fr = r * 0.86 + 22 + 10;
          let fg = g * 0.86 + 22 + 2;
          let fb = b * 0.86 + 22 - 10;
          const gray = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
          fr = gray + (fr - gray) * 0.8;
          fg = gray + (fg - gray) * 0.8;
          fb = gray + (fb - gray) * 0.8;
          const dist = Math.hypot(x - cx, y - cy) / maxDist;
          const k = 1 - 0.35 * smoothstep(0.55, 1, dist);
          nr = fr * k;
          ng = fg * k;
          nb = fb * k;
          break;
        }
        case 'warm':
          nr = r + 16;
          ng = g + 5;
          nb = b - 14;
          break;
        case 'cool':
          nr = r - 14;
          ng = g + 2;
          nb = b + 16;
          break;
        case 'grain': {
          const n = (rand() * 2 - 1) * 18;
          nr = r + n;
          ng = g + n;
          nb = b + n;
          break;
        }
        case 'vignette': {
          const dist = Math.hypot(x - cx, y - cy) / maxDist;
          const k = 1 - 0.6 * smoothstep(0.5, 1, dist);
          nr = r * k;
          ng = g * k;
          nb = b * k;
          break;
        }
      }
      d[i] = r + (nr - r) * mix;
      d[i + 1] = g + (ng - g) * mix;
      d[i + 2] = b + (nb - b) * mix;
    }
  }
  return out;
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
