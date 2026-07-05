import { describe, expect, it } from 'vitest';
import {
  MODEL_FAMILIES,
  defaultSettings,
  familyById,
  upscaleUserPriceUsd,
  userPriceUsd,
} from './model-families';

describe('model families', () => {
  it('has 5 image and 5 video families', () => {
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'image').length).toBe(5);
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'video').length).toBe(5);
  });

  it('nano banana v1 flat cost, v2 priced by resolution', () => {
    const nb = familyById('nano-banana')!;
    expect(nb.providerCost({ version: '1', aspectRatio: '1:1' })).toBeCloseTo(0.039);
    expect(nb.providerCost({ version: '2', aspectRatio: '1:1', resolution: '1K' })).toBeCloseTo(0.067);
    expect(nb.providerCost({ version: '2', aspectRatio: '1:1', resolution: '4K' })).toBeCloseTo(0.151);
  });

  it('gpt image priced by version x quality, v2 4K doubles', () => {
    const gpt = familyById('gpt-image')!;
    expect(
      gpt.providerCost({ version: '2', aspectRatio: '1:1', quality: 'high', resolution: '1K' }),
    ).toBeCloseTo(0.211);
    expect(
      gpt.providerCost({ version: '1', aspectRatio: '1:1', quality: 'low', resolution: '1K' }),
    ).toBeCloseTo(0.011);
    expect(
      gpt.providerCost({ version: '2', aspectRatio: '1:1', quality: 'low', resolution: '4K' }),
    ).toBeCloseTo(0.0123, 3);
  });

  it('video cost scales with duration', () => {
    const veo = familyById('veo')!;
    const base = veo.providerCost({
      version: 'standard',
      aspectRatio: '16:9',
      resolution: '1080p',
      durationS: 4,
    });
    const longer = veo.providerCost({
      version: 'standard',
      aspectRatio: '16:9',
      resolution: '1080p',
      durationS: 8,
    });
    expect(longer).toBeCloseTo(base * 2);
  });

  it('defaultSettings picks sensible defaults per axis', () => {
    const gpt = familyById('gpt-image')!;
    const s = defaultSettings(gpt);
    expect(s.version).toBe('2');
    expect(s.quality).toBe('medium');
    expect(s.aspectRatio).toBe(gpt.capabilities.aspectRatios[0]);
  });

  it('user price applies 33% margin', () => {
    const nb = familyById('nano-banana')!;
    expect(userPriceUsd(nb, { version: '1', aspectRatio: '1:1' })).toBeCloseTo(0.039 / 0.67);
    expect(upscaleUserPriceUsd()).toBeCloseTo(0.25 / 0.67);
    expect(upscaleUserPriceUsd(true)).toBeCloseTo(1.5 / 0.67);
  });

  it('every family has logo, blurb, and tooltips on every option', () => {
    for (const f of MODEL_FAMILIES) {
      expect(f.logo).toMatch(/^\/logos\//);
      expect(f.blurb.length).toBeGreaterThan(10);
      for (const opts of [
        f.capabilities.versions,
        f.capabilities.resolutions,
        f.capabilities.qualities,
      ]) {
        for (const o of opts ?? []) expect(o.tooltip.length).toBeGreaterThan(10);
      }
    }
  });
});
