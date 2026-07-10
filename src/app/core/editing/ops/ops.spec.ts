import { describe, expect, it } from 'vitest';
import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { adjust } from './adjust';
import { sharpen, smooth } from './convolve';
import { crop, rotate90 } from './crop';
import { liquify } from './liquify';

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

describe('clonePixels', () => {
  it('deep-copies', () => {
    const src = solid(2, 2, [1, 1, 1, 255]);
    const copy = clonePixels(src);
    copy.data[0] = 99;
    expect(src.data[0]).toBe(1);
  });
});
