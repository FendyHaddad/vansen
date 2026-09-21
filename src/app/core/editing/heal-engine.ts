import * as ort from 'onnxruntime-web';
import { acquireOrtSession, type SessionLease } from './engines/model-loader';
import { PixelBuffer, clonePixels } from './pixel-buffer';
import { healEngineReady, healModelProgress } from './heal-status';

/**
 * Content-aware spot heal via MI-GAN (Picsart, ICCV 2023, MIT license) —
 * a real inpainting network running fully in the browser through
 * onnxruntime-web (WebGPU when available, wasm otherwise). The ONNX pipeline
 * crops around the mask, resizes to 512, inpaints, and pastes back at the
 * original resolution, so quality is independent of image size.
 *
 * The 28 MB model downloads once and lives in Cache Storage after that.
 * This module is loaded via dynamic import only when the user heals — keep
 * it out of every eager chunk. Offline / failure falls back to the local
 * PatchMatch op (see edit-session.applyHeal).
 */


async function leaseSession(): Promise<SessionLease> {
  const lease = await acquireOrtSession('heal-migan', healModelProgress);
  healEngineReady.set(true);
  return lease;
}

/**
 * Inpaint the masked pixels. mask = 1 byte/pixel, 255 where healing applies.
 * Only masked pixels are replaced — everything else stays bit-identical.
 */
export async function healSmart(buf: PixelBuffer, mask: Uint8Array): Promise<PixelBuffer> {
  const n = buf.width * buf.height;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      any = true;
      break;
    }
  }
  if (!any) return clonePixels(buf);

  const lease = await leaseSession();
  try {
    return await inpaint(lease.session, buf, mask, n);
  } finally {
    await lease.release();
  }
}

async function inpaint(
  session: ort.InferenceSession,
  buf: PixelBuffer,
  mask: Uint8Array,
  n: number,
): Promise<PixelBuffer> {
  const { width: w, height: h, data } = buf;

  // MI-GAN pipeline inputs: image uint8 [1,3,H,W] RGB planes; mask uint8
  // [1,1,H,W] where 255 = known pixel, 0 = region to inpaint.
  const img = new Uint8Array(3 * n);
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    img[i] = data[p];
    img[n + i] = data[p + 1];
    img[2 * n + i] = data[p + 2];
    keep[i] = mask[i] ? 0 : 255;
  }

  const names = session.inputNames;
  const maskName = names.find((x) => x.toLowerCase().includes('mask')) ?? names[1];
  const imageName = names.find((x) => x !== maskName) ?? names[0];
  const results = await session.run({
    [imageName]: new ort.Tensor('uint8', img, [1, 3, h, w]),
    [maskName]: new ort.Tensor('uint8', keep, [1, 1, h, w]),
  });
  const out = results[session.outputNames[0]].data as Uint8Array;

  const healed = clonePixels(buf);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    healed.data[p] = out[i];
    healed.data[p + 1] = out[n + i];
    healed.data[p + 2] = out[2 * n + i];
  }
  return healed;
}
