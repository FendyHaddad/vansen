import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface AdjustParams {
  /** −100..100 each; 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Brightness/contrast/saturation in one pass. Alpha is never touched. */
export function adjust(buf: PixelBuffer, p: AdjustParams): PixelBuffer {
  if (p.brightness === 0 && p.contrast === 0 && p.saturation === 0) return clonePixels(buf);
  const out = clonePixels(buf);
  const d = out.data;
  const bShift = (p.brightness / 100) * 128;
  const cFactor = (259 * (p.contrast + 255)) / (255 * (259 - p.contrast));
  const sFactor = 1 + p.saturation / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r: number = d[i];
    let g: number = d[i + 1];
    let b: number = d[i + 2];
    r += bShift;
    g += bShift;
    b += bShift;
    r = cFactor * (r - 128) + 128;
    g = cFactor * (g - 128) + 128;
    b = cFactor * (b - 128) + 128;
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sFactor;
    g = gray + (g - gray) * sFactor;
    b = gray + (b - gray) * sFactor;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b; // Uint8ClampedArray clamps to 0..255
  }
  return out;
}
