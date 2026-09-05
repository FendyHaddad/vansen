import { describe, expect, it } from 'vitest';
import { MODEL_FAMILIES } from './model-families';
import { TREND_PRESETS, trendById } from './trend-presets';

const IMAGE_ARS = MODEL_FAMILIES.find((f) => f.id === 'flux')!.capabilities.aspectRatios;

describe('trend presets', () => {
  it('ships 12 unique trends with non-empty prompts and thumbs', () => {
    expect(TREND_PRESETS.length).toBe(12);
    expect(new Set(TREND_PRESETS.map((t) => t.id)).size).toBe(12);
    for (const t of TREND_PRESETS) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.thumb).toBe(`/trends/${t.id}.webp`);
    }
  });

  it('suggested aspect ratios are valid image ARs', () => {
    for (const t of TREND_PRESETS) {
      if (t.aspectRatio) expect(IMAGE_ARS).toContain(t.aspectRatio);
    }
  });

  it('resolves by id and rejects unknowns', () => {
    expect(trendById('astronaut')?.name).toBe('Astronaut');
    expect(trendById('nope')).toBeNull();
  });
});
