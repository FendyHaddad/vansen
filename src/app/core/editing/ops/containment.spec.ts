import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../pixel-buffer';
import { cloneStamp } from './clone';
import { retouch } from './retouch';
import { heal } from './heal';
import { crop } from './crop';
import { flip, rotate90ccw } from './transform';
import { filter, type FilterPreset } from './filters';
import { adjust } from './adjust';

/**
 * P7 Task 6 Step 1: the regressions that must hold for every local tool,
 * whatever else changes.
 *
 * A brush that touches a pixel it was not told to touch is a data-loss bug
 * that no screenshot review will catch — the damage is a few pixels wide and
 * permanent once saved.
 */

/** A deterministic image: every pixel encodes its own coordinates. */
function coded(w: number, h: number): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x * 7 + y * 13) % 256;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function at(buf: PixelBuffer, x: number, y: number): number[] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
}

/** Every pixel outside the disc, compared bit for bit. */
function outsideUnchanged(
  before: PixelBuffer,
  after: PixelBuffer,
  cx: number,
  cy: number,
  radius: number,
): string[] {
  const damage: string[] = [];
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius + 1) continue;
      const i = (y * before.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        if (before.data[i + c] === after.data[i + c]) continue;
        damage.push(`(${x},${y}) channel ${c}`);
      }
    }
  }
  return damage;
}

describe('brush containment', () => {
  it('clone stamp leaves every pixel outside its radius bit-identical', () => {
    const src = coded(64, 64);
    const out = cloneStamp(src, { sx: 10, sy: 10, tx: 40, ty: 40, radius: 8 });

    expect(outsideUnchanged(src, out, 40, 40, 8)).toEqual([]);
    // And it did something inside, or the test above proves nothing.
    expect(at(out, 40, 40)).not.toEqual(at(src, 40, 40));
  });

  it('retouch leaves every pixel outside its radius bit-identical', () => {
    const src = coded(64, 64);
    const out = retouch(src, {
      cx: 20,
      cy: 30,
      radius: 6,
      mode: 'lighten',
      strength: 1,
    });

    expect(outsideUnchanged(src, out, 20, 30, 6)).toEqual([]);
    expect(at(out, 20, 30)).not.toEqual(at(src, 20, 30));
  });

  it('heal changes only the masked pixels', () => {
    const src = coded(48, 48);
    const mask = new Uint8Array(48 * 48);
    for (let y = 20; y < 26; y++) {
      for (let x = 20; x < 26; x++) mask[y * 48 + x] = 255;
    }

    const out = heal(src, mask);

    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        if (mask[y * 48 + x]) continue;
        expect(at(out, x, y), `(${x},${y}) outside the mask`).toEqual(at(src, x, y));
      }
    }
  });
});

describe('geometry coordinates', () => {
  it('crop takes the requested window and nothing else', () => {
    const src = coded(40, 30);
    const out = crop(src, { x: 8, y: 5, width: 10, height: 6 });

    expect([out.width, out.height]).toEqual([10, 6]);
    // The top-left of the crop is the pixel that was at (8,5).
    expect(at(out, 0, 0)).toEqual(at(src, 8, 5));
    expect(at(out, 9, 5)).toEqual(at(src, 17, 10));
  });

  it('a point in the crop maps back to where the customer clicked', () => {
    // A selection made after a crop must land on the same object.
    const src = coded(40, 30);
    const rect = { x: 8, y: 5, width: 10, height: 6 };
    const out = crop(src, rect);
    const inCrop = { x: 3, y: 2 };
    expect(at(out, inCrop.x, inCrop.y)).toEqual(at(src, rect.x + inCrop.x, rect.y + inCrop.y));
  });

  it('rotate and flip are exact inverses of themselves', () => {
    const src = coded(16, 9);
    const roundTrip = flip(flip(src, 'h'), 'h');
    expect(Array.from(roundTrip.data)).toEqual(Array.from(src.data));

    const fourTurns = rotate90ccw(rotate90ccw(rotate90ccw(rotate90ccw(src))));
    expect([fourTurns.width, fourTurns.height]).toEqual([16, 9]);
    expect(Array.from(fourTurns.data)).toEqual(Array.from(src.data));
  });
});

describe('alpha survives the pixel ops', () => {
  function withAlpha(): PixelBuffer {
    const buf = coded(32, 32);
    for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = (i / 4) % 256;
    return buf;
  }

  it('adjust never touches the alpha channel', () => {
    const src = withAlpha();
    const out = adjust(src, { brightness: 40, contrast: 20, saturation: -30 });
    for (let i = 3; i < src.data.length; i += 4) {
      expect(out.data[i]).toBe(src.data[i]);
    }
  });

  it('every one of the 17 filter presets leaves alpha alone', () => {
    // Spelled out rather than derived, so a new preset fails this test until
    // someone has actually checked it.
    const presets: FilterPreset[] = [
      'bw', 'sepia', 'vintage', 'warm', 'cool', 'grain', 'vignette', 'fade',
      'noir', 'matte', 'tealorange', 'goldenhour', 'crossprocess', 'infrared',
      'bleach', 'duotone', 'clarity',
    ];
    expect(presets.length).toBe(17);
    const src = withAlpha();
    for (const preset of presets) {
      const out = filter(src, { preset, intensity: 100 });
      for (let i = 3; i < src.data.length; i += 4) {
        expect(out.data[i], `${preset} at ${i}`).toBe(src.data[i]);
      }
    }
  });
});
