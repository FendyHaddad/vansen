import { describe, expect, it } from 'vitest';
import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { adjust } from './adjust';
import { cloneStamp } from './clone';
import { dehaze } from './dehaze';
import { sharpen, smooth } from './convolve';
import { crop, rotate90 } from './crop';
import { enhance } from './enhance';
import { filter } from './filters';
import { heal } from './heal';
import { levels, lumaHistogram } from './levels';
import { liquify } from './liquify';
import { perspective } from './perspective';
import { portraitSmooth } from './portrait-smooth';
import { retouch } from './retouch';
import { flip, rotate90ccw, straighten } from './transform';
import { dilateMask } from '../engines/raster';

function solid(w: number, h: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
}

describe('adjust', () => {
  it('is identity at zero', () => {
    const src = solid(4, 4, [100, 150, 200, 255]);
    const out = adjust(src, { brightness: 0, contrast: 0, saturation: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('brightness shifts channels, alpha untouched', () => {
    const out = adjust(solid(2, 2, [100, 100, 100, 255]), {
      brightness: 50,
      contrast: 0,
      saturation: 0,
    });
    expect(out.data[0]).toBeGreaterThan(100);
    expect(out.data[3]).toBe(255);
  });

  it('saturation -100 produces gray (R=G=B)', () => {
    const out = adjust(solid(2, 2, [200, 50, 100, 255]), {
      brightness: 0,
      contrast: 0,
      saturation: -100,
    });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
  });
});

describe('convolve', () => {
  it('sharpen/smooth at 0 are identity', () => {
    const src = solid(4, 4, [10, 20, 30, 255]);
    expect(Array.from(sharpen(src, 0).data)).toEqual(Array.from(src.data));
    expect(Array.from(smooth(src, 0).data)).toEqual(Array.from(src.data));
  });

  it('smooth pulls an outlier pixel toward neighbors', () => {
    const src = solid(3, 3, [0, 0, 0, 255]);
    src.data.set([255, 255, 255, 255], (1 * 3 + 1) * 4); // center white
    const out = smooth(src, 100);
    expect(out.data[(1 * 3 + 1) * 4]).toBeLessThan(255);
  });

  it('sharpen increases center-vs-neighbor contrast', () => {
    const src = solid(3, 3, [100, 100, 100, 255]);
    src.data.set([150, 150, 150, 255], (1 * 3 + 1) * 4);
    const out = sharpen(src, 100);
    expect(out.data[(1 * 3 + 1) * 4]).toBeGreaterThan(150);
  });
});

describe('crop / rotate', () => {
  it('crop extracts the requested region', () => {
    const src = solid(4, 4, [1, 2, 3, 255]);
    src.data.set([9, 9, 9, 255], (1 * 4 + 1) * 4); // pixel (1,1)
    const out = crop(src, { x: 1, y: 1, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(9); // (1,1) is now (0,0)
  });

  it('rotate90 CW: output (x,y) = input (y, H-1-x)', () => {
    // 2×1 input, left pixel marked. CW rotation → 1×2 output, mark at bottom.
    const src = solid(2, 1, [0, 0, 0, 255]);
    src.data.set([9, 9, 9, 255], 0);
    const out = rotate90(src);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(9); // top = old left pixel (left edge becomes top edge)
    expect(out.data[4]).toBe(0); // bottom = old right pixel
  });
});

describe('liquify', () => {
  it('zero displacement is identity', () => {
    const src = solid(4, 4, [50, 60, 70, 255]);
    const out = liquify(src, { cx: 2, cy: 2, radius: 2, dx: 0, dy: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('pushes pixels inside the brush radius', () => {
    const src = solid(8, 8, [0, 0, 0, 255]);
    src.data.set([255, 255, 255, 255], (4 * 8 + 2) * 4); // white at (2,4)
    const out = liquify(src, { cx: 3, cy: 4, radius: 3, dx: 2, dy: 0 });
    expect(Array.from(out.data)).not.toEqual(Array.from(src.data));
  });
});

describe('heal', () => {
  it('repairs a masked blemish from surrounding texture', () => {
    const src = solid(16, 16, [120, 120, 120, 255]);
    const mask = new Uint8Array(16 * 16);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        src.data.set([255, 255, 255, 255], ((7 + dy) * 16 + 7 + dx) * 4);
        mask[(7 + dy) * 16 + 7 + dx] = 255;
      }
    }
    const out = heal(src, mask);
    expect(Math.abs(out.data[(7 * 16 + 7) * 4] - 120)).toBeLessThan(20);
    // Unmasked pixels untouched.
    expect(out.data[0]).toBe(120);
  });

  it('empty mask is identity', () => {
    const src = solid(4, 4, [10, 20, 30, 255]);
    const out = heal(src, new Uint8Array(16));
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

describe('transform', () => {
  it('rotate90ccw: right edge becomes top edge', () => {
    // 2×1 input, right pixel marked. CCW → 1×2 output, mark on top.
    const src = solid(2, 1, [0, 0, 0, 255]);
    src.data.set([9, 9, 9, 255], 4);
    const out = rotate90ccw(src);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(9);
    expect(out.data[4]).toBe(0);
  });

  it('flip mirrors along each axis', () => {
    const src = solid(2, 2, [0, 0, 0, 255]);
    src.data.set([9, 9, 9, 255], 0); // top-left
    const fh = flip(src, 'h');
    expect(fh.data[4]).toBe(9); // now top-right
    const fv = flip(src, 'v');
    expect(fv.data[(1 * 2 + 0) * 4]).toBe(9); // now bottom-left
  });

  it('straighten at 0° is identity', () => {
    const src = solid(4, 4, [10, 20, 30, 255]);
    const out = straighten(src, { degrees: 0, crop: true });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('straighten with crop shrinks the frame, without crop keeps it', () => {
    const src = solid(20, 10, [100, 100, 100, 255]);
    const cropped = straighten(src, { degrees: 10, crop: true });
    expect(cropped.width).toBeLessThan(20);
    expect(cropped.height).toBeLessThan(10);
    const kept = straighten(src, { degrees: 10, crop: false });
    expect(kept.width).toBe(20);
    expect(kept.height).toBe(10);
  });

  it('straighten crop keeps only source pixels (no dark corners)', () => {
    const src = solid(40, 40, [100, 100, 100, 255]);
    const out = straighten(src, { degrees: 15, crop: true });
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i + 3]).toBe(255);
      expect(Math.abs(out.data[i] - 100)).toBeLessThan(2);
    }
  });
});

describe('filter', () => {
  it('intensity 0 is identity', () => {
    const src = solid(4, 4, [120, 80, 40, 255]);
    const out = filter(src, { preset: 'sepia', intensity: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('bw at full intensity produces gray', () => {
    const out = filter(solid(2, 2, [200, 50, 100, 255]), { preset: 'bw', intensity: 100 });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
    expect(out.data[3]).toBe(255);
  });

  it('warm raises red and lowers blue', () => {
    const out = filter(solid(2, 2, [100, 100, 100, 255]), { preset: 'warm', intensity: 100 });
    expect(out.data[0]).toBeGreaterThan(100);
    expect(out.data[2]).toBeLessThan(100);
  });

  it('vignette darkens corners more than the center', () => {
    const src = solid(9, 9, [200, 200, 200, 255]);
    const out = filter(src, { preset: 'vignette', intensity: 100 });
    const center = out.data[(4 * 9 + 4) * 4];
    const corner = out.data[0];
    expect(corner).toBeLessThan(center);
  });

  it('grain is deterministic between runs', () => {
    const src = solid(4, 4, [128, 128, 128, 255]);
    const a = filter(src, { preset: 'grain', intensity: 100 });
    const b = filter(src, { preset: 'grain', intensity: 100 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('dehaze', () => {
  it('strength 0 is identity', () => {
    const hazy = solid(4, 4, [180, 180, 180, 255]);
    const out = dehaze(hazy, { strength: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(hazy.data));
  });

  it('increases contrast (widens the value range) at full strength', () => {
    const graded: PixelBuffer = {
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(
        Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 : 120 + ((i >> 2) % 16) * 4)),
      ),
    };
    const out = dehaze(graded, { strength: 100 });
    const range = (d: ArrayLike<number>) => {
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < d.length; i++) {
        if (i % 4 !== 3) {
          lo = Math.min(lo, d[i]);
          hi = Math.max(hi, d[i]);
        }
      }
      return hi - lo;
    };
    expect(range(out.data)).toBeGreaterThanOrEqual(range(graded.data));
    expect(out.data[3]).toBe(255);
  });
});

describe('portraitSmooth', () => {
  it('strength 0 is identity', () => {
    const buf = solid(8, 8, [150, 150, 150, 255]);
    const out = portraitSmooth(buf, { strength: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(buf.data));
  });

  it('reduces high-frequency variance on skin-tone noise, keeps alpha', () => {
    // Skin-ish base with per-pixel speckle.
    const w = 16;
    const h = 16;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const q = i * 4;
      const n = i % 2 ? 12 : -12;
      data[q] = 200 + n;
      data[q + 1] = 150 + n;
      data[q + 2] = 120 + n;
      data[q + 3] = 255;
    }
    const buf: PixelBuffer = { width: w, height: h, data };
    const out = portraitSmooth(buf, { strength: 100 });
    const variance = (d: ArrayLike<number>) => {
      let s = 0;
      let s2 = 0;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        s += d[i];
        s2 += d[i] * d[i];
        count++;
      }
      return s2 / count - (s / count) ** 2;
    };
    expect(variance(out.data)).toBeLessThan(variance(buf.data));
    expect(out.data[3]).toBe(255);
  });
});

describe('filter — new presets', () => {
  const px = (r: number, g: number, b: number): PixelBuffer => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([r, g, b, 255]),
  });
  const presets = [
    'fade',
    'noir',
    'matte',
    'tealorange',
    'goldenhour',
    'crossprocess',
    'infrared',
    'bleach',
    'duotone',
    'clarity',
  ] as const;

  it('intensity 0 is identity for every new preset', () => {
    for (const preset of presets) {
      const out = filter(px(120, 90, 60), { preset, intensity: 0 });
      expect([out.data[0], out.data[1], out.data[2]]).toEqual([120, 90, 60]);
    }
  });

  it('keeps alpha untouched and stays in 0..255', () => {
    for (const preset of presets) {
      const out = filter(px(200, 40, 10), { preset, intensity: 100 });
      expect(out.data[3]).toBe(255);
      for (let c = 0; c < 3; c++) expect(out.data[c]).toBeGreaterThanOrEqual(0);
    }
  });

  it('duotone maps luminance between colorA (shadow) and colorB (highlight)', () => {
    const params = {
      intensity: 100,
      colorA: [10, 20, 30] as [number, number, number],
      colorB: [240, 230, 220] as [number, number, number],
    };
    const black = filter(px(0, 0, 0), { preset: 'duotone', ...params });
    const white = filter(px(255, 255, 255), { preset: 'duotone', ...params });
    expect([black.data[0], black.data[1], black.data[2]]).toEqual([10, 20, 30]);
    expect([white.data[0], white.data[1], white.data[2]]).toEqual([240, 230, 220]);
  });

  it('noir at full intensity produces gray', () => {
    const out = filter(px(200, 50, 100), { preset: 'noir', intensity: 100 });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
  });

  it('clarity boosts local contrast on an edge', () => {
    // Left half dark, right half bright — clarity must push them apart.
    const w = 12;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) {
      const v = i % w < w / 2 ? 80 : 180;
      data.set([v, v, v, 255], i * 4);
    }
    const out = filter({ width: w, height: w, data }, { preset: 'clarity', intensity: 100 });
    const mid = (Math.floor(w / 2) * w + Math.floor(w / 2)) * 4; // bright side of the seam
    const midLeft = (Math.floor(w / 2) * w + Math.floor(w / 2) - 1) * 4; // dark side
    expect(out.data[mid]).toBeGreaterThanOrEqual(180);
    expect(out.data[midLeft]).toBeLessThanOrEqual(80);
  });
});

describe('enhance', () => {
  it('strength 0 is identity', () => {
    const src = solid(4, 4, [90, 90, 90, 255]);
    const out = enhance(src, 0);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('stretches a low-contrast image toward full range', () => {
    // Half 100-gray, half 150-gray → contrast should widen.
    const src = solid(4, 4, [100, 100, 100, 255]);
    for (let i = 0; i < 8; i++) src.data.set([150, 150, 150, 255], i * 4);
    const out = enhance(src, 100);
    expect(out.data[0]).toBeGreaterThan(150);
    expect(out.data[(15) * 4]).toBeLessThan(100);
  });
});

describe('levels', () => {
  it('defaults are identity', () => {
    const src = solid(4, 4, [77, 130, 200, 255]);
    const out = levels(src, { black: 0, white: 255, gamma: 1 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('raising the black point crushes shadows', () => {
    const out = levels(solid(2, 2, [40, 40, 40, 255]), { black: 50, white: 255, gamma: 1 });
    expect(out.data[0]).toBe(0);
  });

  it('gamma above 1 brightens midtones', () => {
    const out = levels(solid(2, 2, [128, 128, 128, 255]), { black: 0, white: 255, gamma: 2 });
    expect(out.data[0]).toBeGreaterThan(128);
  });

  it('lumaHistogram normalizes the tallest bin to 1', () => {
    const bins = lumaHistogram(solid(4, 4, [128, 128, 128, 255]));
    expect(bins[128]).toBe(1);
  });
});

describe('cloneStamp', () => {
  it('copies pixels from the source circle onto the target', () => {
    const src = solid(20, 20, [0, 0, 0, 255]);
    // 5×5 white patch around (4,4)
    for (let y = 2; y <= 6; y++) {
      for (let x = 2; x <= 6; x++) src.data.set([255, 255, 255, 255], (y * 20 + x) * 4);
    }
    const out = cloneStamp(src, { sx: 4, sy: 4, tx: 14, ty: 14, radius: 2 });
    expect(out.data[(14 * 20 + 14) * 4]).toBe(255); // stamped center now white
    expect(out.data[(4 * 20 + 4) * 4]).toBe(255); // source untouched
    expect(out.data[0]).toBe(0); // far corner untouched
  });

  it('skips samples that fall outside the image', () => {
    const src = solid(10, 10, [50, 50, 50, 255]);
    const out = cloneStamp(src, { sx: -20, sy: -20, tx: 5, ty: 5, radius: 3 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('strength scales dab opacity — 0.5 lands halfway, 0 is a no-op', () => {
    const src = solid(20, 20, [0, 0, 0, 255]);
    src.data.set([200, 200, 200, 255], (4 * 20 + 4) * 4);
    const half = cloneStamp(src, { sx: 4, sy: 4, tx: 14, ty: 14, radius: 2, strength: 0.5 });
    expect(half.data[(14 * 20 + 14) * 4]).toBe(100);
    const none = cloneStamp(src, { sx: 4, sy: 4, tx: 14, ty: 14, radius: 2, strength: 0 });
    expect(Array.from(none.data)).toEqual(Array.from(src.data));
  });
});

describe('retouch', () => {
  it('lighten raises values inside the brush only', () => {
    const src = solid(10, 10, [100, 100, 100, 255]);
    const out = retouch(src, { cx: 5, cy: 5, radius: 3, mode: 'lighten', strength: 1 });
    expect(out.data[(5 * 10 + 5) * 4]).toBeGreaterThan(100);
    expect(out.data[0]).toBe(100);
  });

  it('darken lowers values, desaturate grays them', () => {
    const dark = retouch(solid(10, 10, [100, 100, 100, 255]), {
      cx: 5, cy: 5, radius: 3, mode: 'darken', strength: 1,
    });
    expect(dark.data[(5 * 10 + 5) * 4]).toBeLessThan(100);
    const gray = retouch(solid(10, 10, [200, 50, 100, 255]), {
      cx: 5, cy: 5, radius: 3, mode: 'desaturate', strength: 1,
    });
    const i = (5 * 10 + 5) * 4;
    const spreadBefore = 200 - 50;
    const spreadAfter = Math.abs(gray.data[i] - gray.data[i + 1]);
    expect(spreadAfter).toBeLessThan(spreadBefore);
  });

  it('feather 0 keeps the edge solid; feather 1 fades toward the rim', () => {
    const base = () => solid(21, 21, [100, 100, 100, 255]);
    const edge = (buf: { data: Uint8ClampedArray }) => buf.data[(10 * 21 + 17) * 4]; // ~0.9r
    const hard = retouch(base(), { cx: 10, cy: 10, radius: 8, mode: 'lighten', strength: 1, feather: 0 });
    const soft = retouch(base(), { cx: 10, cy: 10, radius: 8, mode: 'lighten', strength: 1, feather: 1 });
    expect(edge(hard)).toBeGreaterThan(edge(soft));
    // Center gets the full effect either way.
    expect(hard.data[(10 * 21 + 10) * 4]).toBe(soft.data[(10 * 21 + 10) * 4]);
  });
});

describe('perspective', () => {
  it('zero keystone is identity', () => {
    const src = solid(6, 6, [10, 20, 30, 255]);
    const out = perspective(src, { vertical: 0, horizontal: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('always fills the frame — no transparent pixels', () => {
    const src = solid(20, 20, [80, 80, 80, 255]);
    const out = perspective(src, { vertical: 60, horizontal: -40 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });
});

describe('dilateMask', () => {
  it('grows a single pixel into a square of the given radius', () => {
    const mask = new Uint8Array(7 * 7);
    mask[3 * 7 + 3] = 255;
    const out = dilateMask(mask, 7, 7, 2);
    // Chebyshev distance ≤ 2 → 5×5 block set, corners of the 7×7 untouched.
    expect(out[1 * 7 + 1]).toBe(255);
    expect(out[5 * 7 + 5]).toBe(255);
    expect(out[0]).toBe(0);
    expect(out[6 * 7 + 6]).toBe(0);
    // Source pixel stays set; the input array is untouched.
    expect(out[3 * 7 + 3]).toBe(255);
    expect(mask[1 * 7 + 1]).toBe(0);
  });
});

describe('clonePixels', () => {
  it('deep-copies', () => {
    const src = solid(2, 2, [1, 1, 1, 255]);
    const copy = clonePixels(src);
    copy.data[0] = 99;
    expect(src.data[0]).toBe(1);
  });
});
