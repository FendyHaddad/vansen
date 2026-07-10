import * as ort from 'onnxruntime-web';
import { PixelBuffer } from '../pixel-buffer';
import { MAX_UPSCALE_PIXELS, upscaleModelProgress, upscaleTileProgress } from './engine-status';
import { getOrtSession } from './model-loader';

/**
 * 2× super-resolution via Swin2SR lightweight (caidas, Apache-2.0; Xenova
 * ONNX export — 8 MB). Tiled inference keeps memory flat on any image size;
 * upscaleTileProgress reports 0..1 across tiles.
 */

const MODEL_URL =
  'https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx';
const SCALE = 2;
const TILE = 224; // core tile edge, must keep TILE+2*OV a multiple of 8
const OV = 16; // overlap trimmed from every side to hide seams


/** Swin2SR is fragile on the WebGPU EP (heavy shape-dependent Reshapes) —
 * validate the first tile's output and hot-swap to a CPU (wasm) session if
 * the GPU one throws or returns non-finite/degenerate pixels. */
function saneTile(up: Float32Array): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < up.length; i += 97) {
    const v = up[i];
    if (!Number.isFinite(v) || v < -4 || v > 8) return false;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min > 1e-6;
}

export async function upscale2x(buf: PixelBuffer): Promise<PixelBuffer> {
  if (buf.width * buf.height > MAX_UPSCALE_PIXELS) {
    throw new Error('too_large');
  }
  let session = await getOrtSession(MODEL_URL, upscaleModelProgress);
  let validated = false;
  const { width: w, height: h } = buf;
  const out: PixelBuffer = {
    width: w * SCALE,
    height: h * SCALE,
    data: new Uint8ClampedArray(w * SCALE * h * SCALE * 4),
  };
  const cols = Math.ceil(w / TILE);
  const rows = Math.ceil(h / TILE);
  const total = cols * rows;
  let done = 0;
  upscaleTileProgress.set(0);
  try {
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const coreX = tx * TILE;
        const coreY = ty * TILE;
        const coreW = Math.min(TILE, w - coreX);
        const coreH = Math.min(TILE, h - coreY);
        // Read window = core + overlap, clamped to the image.
        const srcX = Math.max(0, coreX - OV);
        const srcY = Math.max(0, coreY - OV);
        const srcW = Math.min(w, coreX + coreW + OV) - srcX;
        const srcH = Math.min(h, coreY + coreH + OV) - srcY;
        // Pad up to a multiple of 8 (Swin window size) with edge replication.
        const padW = Math.ceil(srcW / 8) * 8;
        const padH = Math.ceil(srcH / 8) * 8;
        const planes = new Float32Array(3 * padW * padH);
        for (let y = 0; y < padH; y++) {
          const sy = srcY + Math.min(y, srcH - 1);
          for (let x = 0; x < padW; x++) {
            const sx = srcX + Math.min(x, srcW - 1);
            const p = (sy * w + sx) * 4;
            const o = y * padW + x;
            planes[o] = buf.data[p] / 255;
            planes[padW * padH + o] = buf.data[p + 1] / 255;
            planes[2 * padW * padH + o] = buf.data[p + 2] / 255;
          }
        }
        const feed = () => ({
          [session.inputNames[0]]: new ort.Tensor('float32', planes, [1, 3, padH, padW]),
        });
        let up: Float32Array;
        try {
          up = (await session.run(feed()))[session.outputNames[0]].data as Float32Array;
          if (!validated && !saneTile(up)) throw new Error('gpu output invalid');
        } catch (e) {
          if (validated) throw e;
          session = await getOrtSession(MODEL_URL, upscaleModelProgress, ['wasm']);
          up = (await session.run(feed()))[session.outputNames[0]].data as Float32Array;
        }
        validated = true;
        const upW = padW * SCALE;
        // Write the upscaled core region (skip the overlap margins).
        const offX = (coreX - srcX) * SCALE;
        const offY = (coreY - srcY) * SCALE;
        const plane = upW * padH * SCALE;
        for (let y = 0; y < coreH * SCALE; y++) {
          const uy = offY + y;
          const oy = coreY * SCALE + y;
          for (let x = 0; x < coreW * SCALE; x++) {
            const ui = uy * upW + offX + x;
            const oi = (oy * out.width + coreX * SCALE + x) * 4;
            out.data[oi] = up[ui] * 255;
            out.data[oi + 1] = up[plane + ui] * 255;
            out.data[oi + 2] = up[2 * plane + ui] * 255;
            out.data[oi + 3] = 255;
          }
        }
        done++;
        upscaleTileProgress.set(done / total);
      }
    }
  } finally {
    upscaleTileProgress.set(null);
  }
  // The network is RGB-only — carry transparency (e.g. after Cut Out) across
  // with a plain bilinear resample of the alpha channel.
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(h - 1, y / SCALE);
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(w - 1, x / SCALE);
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const top = buf.data[(y0 * w + x0) * 4 + 3] * (1 - fx) + buf.data[(y0 * w + x1) * 4 + 3] * fx;
      const bot = buf.data[(y1 * w + x0) * 4 + 3] * (1 - fx) + buf.data[(y1 * w + x1) * 4 + 3] * fx;
      out.data[(y * out.width + x) * 4 + 3] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}
