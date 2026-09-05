import { describe, expect, it } from 'vitest';
import { fitWithin } from './photo-prep';

// prepPhoto itself needs a real canvas (browser-only); the sizing math is the
// testable core and is covered here.
describe('fitWithin', () => {
  it('downscales to at most 1536px on the long edge, keeping aspect', () => {
    expect(fitWithin(3000, 2000)).toEqual({ width: 1536, height: 1024 });
    expect(fitWithin(2000, 3000)).toEqual({ width: 1024, height: 1536 });
  });

  it('never upscales small images', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('never collapses to zero', () => {
    expect(fitWithin(20000, 1)).toEqual({ width: 1536, height: 1 });
  });
});
