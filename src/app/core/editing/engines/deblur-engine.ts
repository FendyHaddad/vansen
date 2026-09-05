import * as ort from 'onnxruntime-web';
import { PixelBuffer } from '../pixel-buffer';
import { MAX_DEBLUR_PIXELS, deblurModelProgress, deblurTileProgress } from './engine-status';
import { getOrtSession } from './model-loader';

/**
 * AI Sharpen — NAFNet motion/lens deblur (GoPro variant), MIT, ~87.5 MB
 * quantized ONNX from the OpenCV model zoo. Dynamic H×W, NCHW float32 RGB
 * 0..1 in, same-size RGB 0..1 out. Tiled with overlap so any image size runs
 * in flat memory; NAFNet is a 4-level UNet so every tile is padded to a
 * multiple of 16 by edge replication.
 */
const MODEL_URL =
  'https://huggingface.co/opencv/deblurring_nafnet/resolve/main/deblurring_nafnet_2025may.onnx';
/** Core tile size — the region we keep from each inference. */
const TILE = 256;
/** Context overlap on every side, discarded after inference. */
const OV = 32;
const ALIGN = 16;

/** Quick sanity check on the first tile — a broken WebGPU kernel hands back
 * NaN/Infinity or a flat constant; either means "redo on wasm". */
function saneTile(out: Float32Array): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < out.length; i += 97) {
    const v = out[i];
    if (!Number.isFinite(v) || v < -4 || v > 8) return false;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min > 1e-6;
}

/** Deblur the whole buffer on-device. Alpha passes through untouched. */
export async function deblur(buf: PixelBuffer): Promise<PixelBuffer> {
  if (buf.width * buf.height > MAX_DEBLUR_PIXELS) throw new Error('too_large');
  const { width: w, height: h, data: src } = buf;
  let session = await getOrtSession(MODEL_URL, deblurModelProgress);
  let validated = false;

  const out = new Uint8ClampedArray(w * h * 4);
  const cols = Math.ceil(w / TILE);
  const rows = Math.ceil(h / TILE);
  const total = cols * rows;
  let done = 0;
  deblurTileProgress.set(0);
  try {
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const coreX = tx * TILE;
        const coreY = ty * TILE;
        const coreW = Math.min(TILE, w - coreX);
        const coreH = Math.min(TILE, h - coreY);
        const x0 = Math.max(0, coreX - OV);
        const y0 = Math.max(0, coreY - OV);
        const x1 = Math.min(w, coreX + coreW + OV);
        const y1 = Math.min(h, coreY + coreH + OV);
        const winW = x1 - x0;
        const winH = y1 - y0;
        const padW = Math.ceil(winW / ALIGN) * ALIGN;
        const padH = Math.ceil(winH / ALIGN) * ALIGN;

        const planes = new Float32Array(3 * padW * padH);
        const plane = padW * padH;
        for (let y = 0; y < padH; y++) {
          const sy = y0 + Math.min(y, winH - 1);
          for (let x = 0; x < padW; x++) {
            const sx = x0 + Math.min(x, winW - 1);
            const si = (sy * w + sx) * 4;
            const di = y * padW + x;
            planes[di] = src[si] / 255;
            planes[plane + di] = src[si + 1] / 255;
            planes[2 * plane + di] = src[si + 2] / 255;
          }
        }

        const feed = () => ({
          [session.inputNames[0]]: new ort.Tensor('float32', planes, [1, 3, padH, padW]),
        });
        let res: Float32Array;
        try {
          res = (await session.run(feed()))[session.outputNames[0]].data as Float32Array;
          if (!validated && !saneTile(res)) throw new Error('gpu output invalid');
        } catch (e) {
          if (validated) throw e;
          session = await getOrtSession(MODEL_URL, deblurModelProgress, ['wasm']);
          res = (await session.run(feed()))[session.outputNames[0]].data as Float32Array;
        }
        validated = true;

        // Copy the core region back; window offset = core − window origin.
        const offX = coreX - x0;
        const offY = coreY - y0;
        for (let y = 0; y < coreH; y++) {
          const ry = offY + y;
          for (let x = 0; x < coreW; x++) {
            const ri = ry * padW + offX + x;
            const oi = ((coreY + y) * w + coreX + x) * 4;
            out[oi] = res[ri] * 255;
            out[oi + 1] = res[plane + ri] * 255;
            out[oi + 2] = res[2 * plane + ri] * 255;
            out[oi + 3] = src[oi + 3];
          }
        }
        done++;
        deblurTileProgress.set(done / total);
      }
    }
  } finally {
    deblurTileProgress.set(null);
  }
  return { width: w, height: h, data: out };
}
