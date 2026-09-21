import { describe, expect, it } from 'vitest';
import { assertPixelBudget, PREVIEW_MAX_DIM, scalePoint } from './editor-policy';

/** Tiny budgets on purpose: these are not the production numbers. */
const tiny = { maxInputPixels: 4, maxOutputPixels: 16 };

describe('assertPixelBudget', () => {
  it('accepts an image inside both limits', () => {
    expect(() => assertPixelBudget(2, 2, 2, tiny)).not.toThrow();
  });

  it('rejects an input over the input limit', () => {
    expect(() => assertPixelBudget(3, 2, 2, tiny)).toThrow(/size/i);
  });

  it('rejects an input whose OUTPUT would be over the limit', () => {
    // The input fits; 2x of it does not. Checking only the input is how a
    // 4x allocation gets made for an image that looked acceptable.
    expect(() => assertPixelBudget(2, 2, 2, { ...tiny, maxOutputPixels: 15 })).toThrow(/size/i);
  });

  it('rejects dimensions that are not positive whole numbers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => assertPixelBudget(bad, 2, 1, tiny), String(bad)).toThrow(/whole number/i);
      expect(() => assertPixelBudget(2, bad, 1, tiny), String(bad)).toThrow(/whole number/i);
      expect(() => assertPixelBudget(2, 2, bad, tiny), String(bad)).toThrow(/whole number/i);
    }
  });

  it('rejects an area that overflows a safe integer before multiplying it out', () => {
    const huge = 2 ** 40;
    expect(() => assertPixelBudget(huge, huge, 1, {
      maxInputPixels: Number.MAX_SAFE_INTEGER,
      maxOutputPixels: Number.MAX_SAFE_INTEGER,
    })).toThrow(/supported size/i);
  });

  it('the error a customer sees says what to do, not what overflowed', () => {
    expect(() => assertPixelBudget(3, 2, 2, tiny)).toThrow(
      'This image exceeds the supported editing size.',
    );
  });
});

describe('preview proxy geometry', () => {
  it('moves a focus point into proxy space', () => {
    expect(scalePoint({ x: 800, y: 400 }, 0.5)).toEqual({ x: 400, y: 200 });
  });

  it('a full-size proxy leaves the point alone', () => {
    // Preview and commit must agree: at scale 1 they are the same call.
    expect(scalePoint({ x: 37, y: 91 }, 1)).toEqual({ x: 37, y: 91 });
  });

  it('no focus stays no focus', () => {
    expect(scalePoint(null, 0.25)).toBeNull();
  });

  it('round-trips back to the picked pixel within a pixel', () => {
    const picked = { x: 1234, y: 777 };
    const scale = PREVIEW_MAX_DIM / 4000;
    const inProxy = scalePoint(picked, scale)!;
    expect(Math.abs(inProxy.x / scale - picked.x)).toBeLessThan(1);
    expect(Math.abs(inProxy.y / scale - picked.y)).toBeLessThan(1);
  });
});
