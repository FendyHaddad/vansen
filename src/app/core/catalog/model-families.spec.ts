import { describe, expect, it } from 'vitest';
import {
  EDIT_TOOLS,
  MODEL_FAMILIES,
  defaultSettings,
  editToolById,
  familyById,
  upscaleUserPriceUsd,
  userPriceUsd,
} from './model-families';

describe('model families', () => {
  it('has 4 image and 5 video families', () => {
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'image').length).toBe(4);
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'video').length).toBe(5);
  });

  it('nano banana tiers: fast flat, standard by resolution, pro premium', () => {
    const nb = familyById('nano-banana')!;
    expect(nb.providerCost({ version: 'fast', aspectRatio: '1:1' })).toBeCloseTo(0.039);
    expect(
      nb.providerCost({ version: 'standard', aspectRatio: '1:1', resolution: '1K' }),
    ).toBeCloseTo(0.067);
    expect(
      nb.providerCost({ version: 'standard', aspectRatio: '1:1', resolution: '4K' }),
    ).toBeCloseTo(0.151);
    expect(nb.providerCost({ version: 'pro', aspectRatio: '1:1', resolution: '2K' })).toBeCloseTo(0.134);
    expect(nb.providerCost({ version: 'pro', aspectRatio: '1:1', resolution: '4K' })).toBeCloseTo(0.24);
  });

  it('nano banana defaults to the Standard (Latest) tier', () => {
    const nb = familyById('nano-banana')!;
    expect(defaultSettings(nb).version).toBe('standard');
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
    expect(userPriceUsd(nb, { version: 'fast', aspectRatio: '1:1' })).toBeCloseTo(0.039 / 0.67);
    expect(upscaleUserPriceUsd()).toBeCloseTo(0.04 / 0.67);
  });

  it('EDIT_TOOLS carries the four fixed-price studio AI tools', () => {
    expect(EDIT_TOOLS.map((t) => t.id)).toEqual([
      'edit-remove',
      'edit-fill',
      'edit-expand',
      'edit-bg',
    ]);
  });

  it('edit tools use fixed retail prices, not the margin formula', () => {
    expect(editToolById('edit-remove')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-fill')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-expand')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-bg')?.userPriceUsd).toBe(0.05);
  });

  it('edit tools mark mask and prompt requirements', () => {
    expect(editToolById('edit-remove')).toMatchObject({ needsMask: true, needsPrompt: false });
    expect(editToolById('edit-fill')).toMatchObject({ needsMask: true, needsPrompt: true });
    expect(editToolById('edit-expand')).toMatchObject({ needsMask: false, needsPrompt: false });
    expect(editToolById('edit-bg')).toMatchObject({ needsMask: false, needsPrompt: false });
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
