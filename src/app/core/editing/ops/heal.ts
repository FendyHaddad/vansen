import { PixelBuffer } from '../pixel-buffer';

type CvModule = typeof import('@techstark/opencv-js');
let cvPromise: Promise<CvModule> | null = null;

/** OpenCV.js is ~8MB of WASM — load it once, only when heal is first used. */
function loadCv(): Promise<CvModule> {
  cvPromise ??= import('@techstark/opencv-js').then(
    (mod) =>
      new Promise<CvModule>((resolve) => {
        const cv = ((mod as unknown as { default?: CvModule }).default ?? mod) as CvModule;
        // opencv-js signals readiness via onRuntimeInitialized when WASM boots
        const boot = cv as unknown as { onRuntimeInitialized?: () => void; Mat?: unknown };
        if (boot.Mat) resolve(cv);
        else boot.onRuntimeInitialized = () => resolve(cv);
      }),
  );
  return cvPromise;
}

/**
 * Classical content-aware spot heal (Telea inpaint): repaints masked pixels
 * from their surroundings. mask = 1 byte/pixel, 255 where healing applies.
 */
export async function heal(buf: PixelBuffer, mask: Uint8Array): Promise<PixelBuffer> {
  const cv = await loadCv();
  const src = cv.matFromImageData({
    data: buf.data,
    width: buf.width,
    height: buf.height,
  } as ImageData);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const maskMat = cv.matFromArray(buf.height, buf.width, cv.CV_8UC1, Array.from(mask));
  const dst = new cv.Mat();
  cv.inpaint(rgb, maskMat, dst, 4, cv.INPAINT_TELEA);
  const rgba = new cv.Mat();
  cv.cvtColor(dst, rgba, cv.COLOR_RGB2RGBA);
  const out: PixelBuffer = {
    width: buf.width,
    height: buf.height,
    data: new Uint8ClampedArray(rgba.data),
  };
  src.delete();
  rgb.delete();
  maskMat.delete();
  dst.delete();
  rgba.delete();
  return out;
}
