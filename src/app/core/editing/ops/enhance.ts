import { PixelBuffer, clonePixels } from '../pixel-buffer';

/**
 * One-click fix: per-channel auto-levels (0.5% percentile clip) plus a
 * gray-world white balance, blended in by strength 0..100.
 */
export function enhance(buf: PixelBuffer, strength: number): PixelBuffer {
  const mix = Math.min(100, Math.max(0, strength)) / 100;
  if (mix === 0) return clonePixels(buf);
  const d = buf.data;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sums = [0, 0, 0];
  const n = buf.width * buf.height;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      hist[c][d[i + c]]++;
      sums[c] += d[i + c];
    }
  }
  const grayMean = (sums[0] + sums[1] + sums[2]) / 3;
  const luts: Uint8ClampedArray[] = [];
  for (let c = 0; c < 3; c++) {
    const lo = percentile(hist[c], n, 0.005);
    const hi = percentile(hist[c], n, 0.995);
    const span = Math.max(1, hi - lo);
    // White balance gain, capped so a legitimately warm/cool scene keeps its mood.
    const gain = Math.min(1.2, Math.max(0.85, grayMean / Math.max(1, sums[c] / n)));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const stretched = (((v - lo) * 255) / span) * gain;
      lut[v] = v + (stretched - v) * mix;
    }
    luts.push(lut);
  }
  const out = clonePixels(buf);
  const od = out.data;
  for (let i = 0; i < od.length; i += 4) {
    od[i] = luts[0][od[i]];
    od[i + 1] = luts[1][od[i + 1]];
    od[i + 2] = luts[2][od[i + 2]];
  }
  return out;
}

function percentile(h: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += h[v];
    if (acc >= target) return v;
  }
  return 255;
}
