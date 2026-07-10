import * as ort from 'onnxruntime-web';
import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { depthModelProgress } from './engine-status';
import { getOrtSession } from './model-loader';
import { resizeBilinear, resizeFloatMap, toPlanarFloat } from './raster';

/**
 * Depth-of-field blur via Depth Anything V2 small (Apache-2.0 — the larger
 * variants are NC-licensed, never swap them in). The 27 MB quantized ONNX
 * downloads once; the depth map is cached per pixel state so slider drags
 * only re-render the blur.
 */

const MODEL_URL =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';
const SIZE = 518;
/** Long-side cap for the blur working copy — full-res sharp pixels stay. */
const WORK_MAX = 1400;

const depthCache = new WeakMap<Uint8ClampedArray, Float32Array>();

/** Normalized 0..1 inverse depth (1 = nearest) at the image's resolution. */
export async function depthMap(buf: PixelBuffer): Promise<Float32Array> {
  const hit = depthCache.get(buf.data);
  if (hit) return hit;
  const session = await getOrtSession(MODEL_URL, depthModelProgress);
  const small = resizeBilinear(buf, SIZE, SIZE);
  const planes = toPlanarFloat(small, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  const results = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', planes, [1, 3, SIZE, SIZE]),
  });
  const raw = results[session.outputNames[0]].data as Float32Array;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < min) min = raw[i];
    if (raw[i] > max) max = raw[i];
  }
  const span = max - min || 1;
  const norm = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) norm[i] = (raw[i] - min) / span;
  const full = resizeFloatMap(norm, SIZE, SIZE, buf.width, buf.height);
  depthCache.set(buf.data, full);
  return full;
}

export interface BokehParams {
  /** Focus point in image px; null = image center. */
  focus: { x: number; y: number } | null;
  /** 0..100 — maximum blur radius. */
  strength: number;
}

/** Blur everything whose depth differs from the focus plane. */
export async function bokeh(buf: PixelBuffer, p: BokehParams): Promise<PixelBuffer> {
  if (p.strength <= 0) return clonePixels(buf);
  const { width: w, height: h } = buf;
  const depth = await depthMap(buf);
  const fx = Math.round(Math.min(w - 1, Math.max(0, p.focus?.x ?? w / 2)));
  const fy = Math.round(Math.min(h - 1, Math.max(0, p.focus?.y ?? h / 2)));
  const focusDepth = depth[fy * w + fx];

  // Blur stack on a bounded working copy; sharp pixels keep full resolution.
  const scale = Math.min(1, WORK_MAX / Math.max(w, h));
  const ww = Math.max(1, Math.round(w * scale));
  const wh = Math.max(1, Math.round(h * scale));
  const work = scale === 1 ? buf : resizeBilinear(buf, ww, wh);
  const radii = [2, 5, 10, 18];
  const stack = radii.map((r) => boxBlur(work, r));

  const maxR = (p.strength / 100) * radii[radii.length - 1];
  const out = clonePixels(buf);
  const d = out.data;
  const xr = ww / w;
  const yr = wh / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = maxR * Math.abs(depth[i] - focusDepth);
      if (r < 0.5) continue;
      // Pick the two nearest blur levels and lerp between them.
      let hi = radii.length - 1;
      while (hi > 0 && radii[hi - 1] >= r) hi--;
      const lo = Math.max(0, hi - 1);
      const t = radii[hi] === radii[lo] ? 0 : Math.min(1, (r - radii[lo]) / (radii[hi] - radii[lo]));
      const wx = Math.min(ww - 1, x * xr);
      const wy = Math.min(wh - 1, y * yr);
      const a = sampleRgb(stack[lo], wx, wy);
      const b = sampleRgb(stack[hi], wx, wy);
      // Feather the focus boundary so the subject doesn't get a hard halo.
      const blend = Math.min(1, (r - 0.5) / 1.5);
      const p4 = i * 4;
      for (let c = 0; c < 3; c++) {
        const blurred = a[c] + (b[c] - a[c]) * t;
        d[p4 + c] = d[p4 + c] + (blurred - d[p4 + c]) * blend;
      }
    }
  }
  return out;
}

function sampleRgb(buf: PixelBuffer, x: number, y: number): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(buf.width - 1, x0 + 1);
  const y1 = Math.min(buf.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = buf.data;
  const i00 = (y0 * buf.width + x0) * 4;
  const i10 = (y0 * buf.width + x1) * 4;
  const i01 = (y1 * buf.width + x0) * 4;
  const i11 = (y1 * buf.width + x1) * 4;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
    const bot = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

/** Two-pass separable box blur (runs twice for a near-gaussian falloff). */
function boxBlur(buf: PixelBuffer, radius: number): PixelBuffer {
  let out = buf;
  for (let pass = 0; pass < 2; pass++) {
    out = blurAxis(blurAxis(out, radius, true), radius, false);
  }
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
