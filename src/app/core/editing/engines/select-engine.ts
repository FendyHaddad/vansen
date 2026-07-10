import * as ort from 'onnxruntime-web';
import { PixelBuffer } from '../pixel-buffer';
import { samModelProgress } from './engine-status';
import { getOrtSession } from './model-loader';
import { resizeBilinear, resizeFloatMap } from './raster';

/**
 * Click-to-mask via SlimSAM-77 (Apache-2.0, Xenova ONNX split into a
 * ~9 MB vision encoder + ~5 MB mask decoder). The image embedding is cached
 * per pixel state, so after the first click every further click is fast.
 */

const ENCODER_URL =
  'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx';
const DECODER_URL =
  'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx';
const SIZE = 1024;
const MASK_SIZE = 256;

interface Embedded {
  outputs: Record<string, ort.Tensor>;
  /** Image → padded-1024 coordinate scale. */
  scale: number;
  rw: number;
  rh: number;
}

const embedCache = new WeakMap<Uint8ClampedArray, Promise<Embedded>>();

function embed(buf: PixelBuffer): Promise<Embedded> {
  let p = embedCache.get(buf.data);
  if (!p) {
    p = runEncoder(buf).catch((e: unknown) => {
      embedCache.delete(buf.data);
      throw e;
    });
    embedCache.set(buf.data, p);
  }
  return p;
}

// The quantized SlimSAM graphs return garbage masks on the WebGPU EP (the
// exact same feeds produce a perfect mask on CPU) — pin both to wasm. The
// encoder runs once per image and is cached, so CPU speed is fine.
const SAM_PROVIDERS: Array<'wasm'> = ['wasm'];

async function runEncoder(buf: PixelBuffer): Promise<Embedded> {
  const session = await getOrtSession(ENCODER_URL, samModelProgress, SAM_PROVIDERS);
  // SAM preprocessing: longest side → 1024, normalize, zero-pad bottom/right.
  const scale = SIZE / Math.max(buf.width, buf.height);
  const rw = Math.max(1, Math.round(buf.width * scale));
  const rh = Math.max(1, Math.round(buf.height * scale));
  const small = resizeBilinear(buf, rw, rh);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const planes = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = (y * rw + x) * 4;
      const o = y * SIZE + x;
      planes[o] = (small.data[p] / 255 - mean[0]) / std[0];
      planes[SIZE * SIZE + o] = (small.data[p + 1] / 255 - mean[1]) / std[1];
      planes[2 * SIZE * SIZE + o] = (small.data[p + 2] / 255 - mean[2]) / std[2];
    }
  }
  const results = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', planes, [1, 3, SIZE, SIZE]),
  });
  const outputs: Record<string, ort.Tensor> = {};
  for (const name of session.outputNames) outputs[name] = results[name];
  return { outputs, scale, rw, rh };
}

/** One selection click: label 1 grows the mask, label 0 carves out. */
export interface SelectPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

/**
 * Mask for the object under the clicked points in image px — 255 inside,
 * 0 outside, sized to the image. Positive points (label 1) say "this is the
 * object", negative points (label 0) say "not this part".
 */
export async function smartSelect(buf: PixelBuffer, points: SelectPoint[]): Promise<Uint8Array> {
  const [emb, decoder] = await Promise.all([
    embed(buf),
    getOrtSession(DECODER_URL, samModelProgress, SAM_PROVIDERS),
  ]);

  const coords = new Float32Array(points.length * 2);
  const labels = new BigInt64Array(points.length);
  points.forEach((p, i) => {
    coords[i * 2] = p.x * emb.scale;
    coords[i * 2 + 1] = p.y * emb.scale;
    labels[i] = BigInt(p.label);
  });
  const feeds: Record<string, ort.Tensor> = {};
  for (const name of decoder.inputNames) {
    if (name === 'input_points') {
      feeds[name] = new ort.Tensor('float32', coords, [1, 1, points.length, 2]);
    } else if (name === 'input_labels') {
      feeds[name] = new ort.Tensor('int64', labels, [1, 1, points.length]);
    } else if (emb.outputs[name]) {
      // image_embeddings / image_positional_embeddings from the encoder.
      feeds[name] = emb.outputs[name];
    } else {
      throw new Error(`sam decoder input not wired: ${name}`);
    }
  }
  const results = await decoder.run(feeds);
  const scores = results['iou_scores'].data as Float32Array;
  const masks = results['pred_masks'].data as Float32Array;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;

  // Logits → 0/1 at the 256² proposal, crop away the padding, resize up.
  const logits = masks.subarray(best * MASK_SIZE * MASK_SIZE, (best + 1) * MASK_SIZE * MASK_SIZE);
  const cropW = Math.max(1, Math.round((emb.rw / SIZE) * MASK_SIZE));
  const cropH = Math.max(1, Math.round((emb.rh / SIZE) * MASK_SIZE));
  const crop = new Float32Array(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) crop[y * cropW + x] = logits[y * MASK_SIZE + x];
  }
  const full = resizeFloatMap(crop, cropW, cropH, buf.width, buf.height);
  const mask = new Uint8Array(buf.width * buf.height);
  for (let i = 0; i < mask.length; i++) mask[i] = full[i] > 0 ? 255 : 0;
  return mask;
}

/** Everything outside the mask becomes transparent. */
export function cutToMask(buf: PixelBuffer, mask: Uint8Array): PixelBuffer {
  const out: PixelBuffer = {
    width: buf.width,
    height: buf.height,
    data: new Uint8ClampedArray(buf.data),
  };
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) out.data[i * 4 + 3] = 0;
  }
  return out;
}
