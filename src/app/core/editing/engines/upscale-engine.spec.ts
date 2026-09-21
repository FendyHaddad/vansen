import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upscale2x } from './upscale-engine';
import { MAX_UPSCALE_PIXELS } from './engine-status';
import { PixelBudgetError } from '../editor-policy';
import { setOrtSessionFactory } from './model-loader';
import type { PixelBuffer } from '../pixel-buffer';

/**
 * R17: an oversized image must be refused BEFORE anything is allocated.
 *
 * The session factory is the observable: acquiring a model is the first
 * thing `upscale2x` does after the guard, so a refusal that never asks for a
 * session never downloaded weights and never allocated an output buffer
 * either.
 */
function buffer(width: number, height: number): PixelBuffer {
  // Deliberately not allocating width*height*4 — these tests are about the
  // guard, and allocating 16 MP of test fixture would defeat the point.
  return { width, height, data: new Uint8ClampedArray(4) };
}

describe('upscale2x size guard', () => {
  let factorySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    factorySpy = vi.fn().mockRejectedValue(new Error('the guard should have stopped this'));
    setOrtSessionFactory(factorySpy as never);
  });

  afterEach(() => setOrtSessionFactory(null));

  it('one pixel over the limit is refused without touching the network', async () => {
    const edge = Math.sqrt(MAX_UPSCALE_PIXELS);
    await expect(upscale2x(buffer(edge + 1, edge))).rejects.toBeInstanceOf(PixelBudgetError);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('the refusal says what the customer should do about it', async () => {
    const edge = Math.sqrt(MAX_UPSCALE_PIXELS);
    await expect(upscale2x(buffer(edge * 2, edge))).rejects.toThrow(
      'This image exceeds the supported editing size.',
    );
  });

  it('a degenerate size is refused as a size problem, not a crash', async () => {
    await expect(upscale2x(buffer(0, 100))).rejects.toBeInstanceOf(PixelBudgetError);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('an image exactly at the limit passes the guard and goes on to load', async () => {
    const edge = Math.sqrt(MAX_UPSCALE_PIXELS);
    // It fails when it asks for the model, which is proof the guard let it
    // through.
    await expect(upscale2x(buffer(edge, edge))).rejects.toThrow(/guard should have stopped/);
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });
});
