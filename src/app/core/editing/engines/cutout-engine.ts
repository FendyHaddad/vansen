import * as ort from 'onnxruntime-web';
import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { cutoutModelProgress } from './engine-status';
import { getOrtSession } from './model-loader';
import { resizeBilinear, resizeFloatMap, toFloat16Bits, toPlanarFloat } from './raster';

/**
 * Background removal via ISNet (DIS, Apache-2.0 architecture; imgly's MIT
 * ONNX export — the exact model behind @imgly/background-removal). Runs fully
 * in the browser; the 88 MB fp16 model downloads once into Cache Storage.
 * Loaded via dynamic import only when the user runs Cut Out.
 */

const MODEL_URL = 'https://huggingface.co/imgly/isnet-general-onnx/resolve/main/onnx/model_fp16.onnx';
const SIZE = 1024;

/** Returns the image with background alpha = 0 (soft matte edges). */
export async function removeBackground(buf: PixelBuffer): Promise<PixelBuffer> {
  const session = await getOrtSession(MODEL_URL, cutoutModelProgress);
  const small = resizeBilinear(buf, SIZE, SIZE);
  const planes = toPlanarFloat(small, [0.5, 0.5, 0.5], [1, 1, 1]);
  const inputName = session.inputNames[0];

  // fp16 exports vary: some keep float32 IO, some demand float16 tensors.
  let results: Awaited<ReturnType<typeof session.run>>;
  try {
    results = await session.run({
      [inputName]: new ort.Tensor('float32', planes, [1, 3, SIZE, SIZE]),
    });
  } catch {
    results = await session.run({
      [inputName]: new ort.Tensor('float16', toFloat16Bits(planes), [1, 3, SIZE, SIZE]),
    });
  }

  const out = results[session.outputNames[0]];
  let matte: Float32Array;
  if (out.type === 'float16') {
    const { fromFloat16Bits } = await import('./raster');
    matte = fromFloat16Bits(out.data as Uint16Array);
  } else {
    matte = out.data as Float32Array;
  }

  // Min-max normalize — ISNet mattes don't always span the full 0..1.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < matte.length; i++) {
    if (matte[i] < min) min = matte[i];
    if (matte[i] > max) max = matte[i];
  }
  const span = max - min || 1;
  const norm = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < norm.length; i++) norm[i] = (matte[i] - min) / span;

  const alpha = resizeFloatMap(norm, SIZE, SIZE, buf.width, buf.height);
  const result = clonePixels(buf);
  const d = result.data;
  for (let i = 0; i < alpha.length; i++) {
    d[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, alpha[i])) * d[i * 4 + 3]);
  }
  return result;
}
