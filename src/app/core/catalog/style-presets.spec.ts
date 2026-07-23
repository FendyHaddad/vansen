import { describe, expect, it } from 'vitest';
import {
  STYLE_CATEGORY_TITLES,
  STYLE_PRESETS,
  applyStyle,
  styleById,
} from './style-presets';

describe('style presets catalog', () => {
  it('has exactly 20 presets, 5 per category', () => {
    expect(STYLE_PRESETS.length).toBe(20);
    for (const category of Object.keys(STYLE_CATEGORY_TITLES)) {
      expect(
        STYLE_PRESETS.filter((p) => p.category === category).length,
        `category ${category}`,
      ).toBe(5);
    }
  });

  it('has unique kebab-case ids and matching thumb paths', () => {
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STYLE_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.thumb).toBe(`/styles/${p.id}.webp`);
    }
  });

  it('keeps every modifier non-empty and under 120 chars', () => {
    for (const p of STYLE_PRESETS) {
      expect(p.modifier.length, p.id).toBeGreaterThan(0);
      expect(p.modifier.length, p.id).toBeLessThanOrEqual(120);
    }
  });

  it('styleById resolves known ids and rejects unknown', () => {
    expect(styleById('oil-painting')?.name).toBe('Oil painting');
    expect(styleById('nope')).toBeNull();
  });

  it('applyStyle appends the modifier, untouched without a style', () => {
    const boosted = applyStyle('a photo of batman', 'oil-painting');
    expect(boosted.startsWith('a photo of batman, ')).toBe(true);
    expect(boosted).toContain(styleById('oil-painting')!.modifier);
    expect(applyStyle('a photo of batman', null)).toBe('a photo of batman');
    expect(applyStyle('a photo of batman', undefined)).toBe('a photo of batman');
    expect(applyStyle('a photo of batman', 'nope')).toBe('a photo of batman');
  });
});
