import { describe, expect, it } from 'vitest';
import { fitWithin, isTooSmall, PERSONA_MAX_EDGE } from './photo-prep';
import { PERSONA_MIN_EDGE } from '../catalog/model-families';

// prepPhoto itself needs a real canvas (browser-only); the sizing math is the
// testable core and is covered here.
describe('persona photo sizing', () => {
  it('keeps detail up to 2048px on the long edge', () => {
    expect(PERSONA_MAX_EDGE).toBe(2048);
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1200, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('rejects a photo under 1024px on its short edge', () => {
    expect(PERSONA_MIN_EDGE).toBe(1024);
    expect(isTooSmall(1000, 3000)).toBe(true);
    expect(isTooSmall(1024, 1024)).toBe(false);
  });

  it('never upscales small images', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('never collapses to zero', () => {
    expect(fitWithin(20000, 1)).toEqual({ width: 2048, height: 1 });
  });
});
