import { PixelBuffer, clonePixels } from '../pixel-buffer';

export type FilterPreset =
  | 'bw'
  | 'sepia'
  | 'vintage'
  | 'warm'
  | 'cool'
  | 'grain'
  | 'vignette'
  | 'fade'
  | 'noir'
  | 'matte'
  | 'tealorange'
  | 'goldenhour'
  | 'crossprocess'
  | 'infrared'
  | 'bleach'
  | 'duotone'
  | 'clarity';

export interface FilterParams {
  preset: FilterPreset;
  /** 0..100 — blends the untouched pixels toward the full effect. */
  intensity: number;
  /** duotone only: shadow tint (RGB 0..255). Defaults to a deep indigo. */
  colorA?: [number, number, number];
  /** duotone only: highlight tint (RGB 0..255). Defaults to a warm cream. */
  colorB?: [number, number, number];
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
  // Local-contrast base for `clarity` — computed once, not per pixel.
  const blurLum =
    p.preset === 'clarity'
      ? blurredLuminance(buf, Math.max(2, Math.round(Math.min(w, h) / 50)))
      : null;
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
        case 'fade': {
          // Lifted blacks, lowered contrast, slight desaturation.
          const lift = 18;
          let fr = lift + r * (1 - lift / 255);
          let fg = lift + g * (1 - lift / 255);
          let fb = lift + b * (1 - lift / 255);
          fr = (fr - 128) * 0.85 + 128;
          fg = (fg - 128) * 0.85 + 128;
          fb = (fb - 128) * 0.85 + 128;
          const gray = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
          nr = gray + (fr - gray) * 0.85;
          ng = gray + (fg - gray) * 0.85;
          nb = gray + (fb - gray) * 0.85;
          break;
        }
        case 'noir': {
          // High-contrast B&W, crushed blacks.
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          nr = ng = nb = (gray - 128) * 1.35 + 118;
          break;
        }
        case 'matte': {
          // Soft contrast curve, muted highlights, faint warm cast.
          const soft = (v: number) => 128 + (v - 128) * 0.82;
          nr = Math.min(soft(r) + 6, 238);
          ng = Math.min(soft(g) + 3, 238);
          nb = Math.min(soft(b) - 2, 238);
          break;
        }
        case 'tealorange': {
          // Cinematic split-tone: teal shadows, orange highlights.
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const shadow = 1 - smoothstep(0, 160, gray);
          const high = smoothstep(96, 255, gray);
          nr = r + high * 20 - shadow * 12;
          ng = g + high * 6 - shadow * 2;
          nb = b - high * 18 + shadow * 22;
          break;
        }
        case 'goldenhour':
          nr = r * 1.06 + 14;
          ng = g * 1.01 + 6;
          nb = b * 0.92 - 6;
          break;
        case 'crossprocess': {
          // Per-channel S-curve with a green/yellow drift.
          const curve = (v: number) => {
            const t = v / 255;
            return (t + 0.5 * t * (1 - t) * (t - 0.5) * -4) * 255;
          };
          nr = curve(r);
          ng = curve(g) + 6;
          nb = curve(b) + 8;
          break;
        }
        case 'infrared': {
          // Channel-swap false color.
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          nr = g * 0.7 + gray * 0.3;
          ng = b * 0.6 + gray * 0.2;
          nb = r * 0.5 + gray * 0.3;
          break;
        }
        case 'bleach': {
          // Bleach bypass: overlay-blend the gray back over itself.
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const overlay = (base: number) => {
            const bl = base / 255;
            const gl = gray / 255;
            const o = gl < 0.5 ? 2 * bl * gl : 1 - 2 * (1 - bl) * (1 - gl);
            return o * 255;
          };
          nr = r * 0.5 + overlay(r) * 0.5;
          ng = g * 0.5 + overlay(g) * 0.5;
          nb = b * 0.5 + overlay(b) * 0.5;
          break;
        }
        case 'duotone': {
          const a = p.colorA ?? [26, 22, 55];
          const c2 = p.colorB ?? [245, 226, 168];
          const gl = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          nr = a[0] + (c2[0] - a[0]) * gl;
          ng = a[1] + (c2[1] - a[1]) * gl;
          nb = a[2] + (c2[2] - a[2]) * gl;
          break;
        }
        case 'clarity': {
          // Unsharp on blurred luminance — local-contrast "pop".
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const boost = (lum - blurLum![y * w + x]) * 0.6;
          nr = r + boost;
          ng = g + boost;
          nb = b + boost;
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

/** Separable box-blurred luminance map, edges clamped. */
function blurredLuminance(buf: PixelBuffer, radius: number): Float32Array {
  const { width: w, height: h, data } = buf;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    lum[i] = 0.2126 * data[q] + 0.7152 * data[q + 1] + 0.0722 * data[q + 2];
  }
  const win = radius * 2 + 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += lum[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      const add = Math.min(w - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      sum += lum[y * w + add] - lum[y * w + sub];
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      const add = Math.min(h - 1, y + radius + 1);
      const sub = Math.max(0, y - radius);
      sum += tmp[add * w + x] - tmp[sub * w + x];
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
