import { describe, expect, it } from 'vitest';
import {
  CREDIT_PACKS,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PERSONA_GEN,
  PERSONA_SLOTS,
  PERSONA_TRAINING,
  PLAN_CREDITS,
  STUDIO_MARGIN,
  VIDEO_DAILY_CAP_USD,
  creditCost,
  defaultSettings,
  editToolById,
  familyById,
  packCredits,
  personaGenCreditCost,
  upscaleCreditCost,
  videoFamilySupports,
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

  it('EDIT_TOOLS carries the four fixed-price studio AI tools', () => {
    expect(EDIT_TOOLS.map((t) => t.id)).toEqual([
      'edit-remove',
      'edit-fill',
      'edit-expand',
      'edit-bg',
    ]);
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

  it('ships the five spec video families and no sora', () => {
    const ids = MODEL_FAMILIES.filter((f) => f.kind === 'video').map((f) => f.id);
    expect(ids).toEqual(['veo', 'omni', 'kling', 'runway', 'seedance']);
    expect(familyById('sora')).toBeUndefined();
  });

  it('every video family declares audio, modes and expectedSPerS', () => {
    for (const f of MODEL_FAMILIES.filter((f) => f.kind === 'video')) {
      expect(['included', 'none', 'selectable']).toContain(f.capabilities.audio);
      expect(f.capabilities.modes?.length).toBeGreaterThan(0);
      expect(f.capabilities.expectedSPerS).toBeGreaterThan(0);
      expect(f.capabilities.aspectRatios).toEqual(['16:9', '9:16', '1:1']);
    }
  });

  it('videoFamilySupports reads capabilities.modes', () => {
    expect(videoFamilySupports(familyById('runway')!, 't2v')).toBe(true);
    expect(videoFamilySupports(familyById('runway')!, 'extend')).toBe(false);
    expect(videoFamilySupports(familyById('omni')!, 'edit')).toBe(true);
    expect(videoFamilySupports(familyById('flux')!, 't2v')).toBe(false);
  });

  it('video pricing matches the spec table', () => {
    const veo = familyById('veo')!;
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'standard', resolution: '1080p', durationS: 8 })).toBeCloseTo(3.2);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'standard', resolution: '4K', durationS: 8 })).toBeCloseTo(4.8);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'fast', resolution: '720p', durationS: 4 })).toBeCloseTo(0.4);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'fast', resolution: '4K', durationS: 4 })).toBeCloseTo(1.2);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'lite', resolution: '1080p', durationS: 4 })).toBeCloseTo(0.32);
    const omni = familyById('omni')!;
    expect(omni.providerCost({ aspectRatio: '16:9', resolution: '4K', durationS: 10 })).toBeCloseTo(3.0);
    const kling = familyById('kling')!;
    expect(kling.providerCost({ aspectRatio: '16:9', durationS: 5, audio: 'off' })).toBeCloseTo(0.56);
    expect(kling.providerCost({ aspectRatio: '16:9', durationS: 5, audio: 'voice' })).toBeCloseTo(0.98);
    expect(familyById('runway')!.providerCost({ aspectRatio: '16:9', durationS: 10 })).toBeCloseTo(1.2);
    expect(familyById('seedance')!.providerCost({ aspectRatio: '16:9', resolution: '480p', durationS: 5 })).toBeCloseTo(1.1025);
  });

  it('defaultSettings sets mode t2v for video and audio off when selectable', () => {
    expect(defaultSettings(familyById('kling')!)).toMatchObject({ mode: 't2v', audio: 'off', durationS: 5 });
    expect(defaultSettings(familyById('veo')!).audio).toBeUndefined();
    expect(defaultSettings(familyById('veo')!).mode).toBe('t2v');
    expect(defaultSettings(familyById('flux')!).mode).toBeUndefined();
  });

  it('exposes the daily video spend cap', () => {
    expect(VIDEO_DAILY_CAP_USD).toBe(40);
  });
});

describe('credit pricing', () => {
  it('uses a 40% studio margin and 1500/3750 grants', () => {
    expect(STUDIO_MARGIN).toBe(0.4);
    expect(PLAN_CREDITS.studio).toBe(1500);
    expect(PLAN_CREDITS.pro).toBe(3750);
  });

  it('computes credit cost as ceil(providerCost / 0.6 * 100)', () => {
    const seedream = familyById('seedream')!;
    // provider $0.03 → $0.05 retail → 5 credits
    expect(creditCost(seedream, defaultSettings(seedream))).toBe(5);
    const flux = familyById('flux')!;
    // provider $0.03 (1MP) → 5 credits
    expect(creditCost(flux, defaultSettings(flux))).toBe(5);
  });

  it('always yields a positive integer for every family/default', () => {
    for (const family of MODEL_FAMILIES) {
      const credits = creditCost(family, defaultSettings(family));
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBeGreaterThan(0);
    }
  });

  it('prices AI edit tools at fixed credit costs', () => {
    const byId = Object.fromEntries(EDIT_TOOLS.map((t) => [t.id, t.creditCost]));
    expect(byId).toEqual({ 'edit-remove': 10, 'edit-fill': 10, 'edit-expand': 10, 'edit-bg': 5 });
    expect(upscaleCreditCost()).toBe(7);
  });

  it('computes pack credits with tier rate and size bonus', () => {
    expect(CREDIT_PACKS.map((p) => p.usd)).toEqual([10, 25, 50, 100]);
    expect(packCredits(10, 'studio')).toBe(1000);
    expect(packCredits(25, 'studio')).toBe(2625);
    expect(packCredits(50, 'studio')).toBe(5400);
    expect(packCredits(100, 'studio')).toBe(11000);
    expect(packCredits(10, 'pro')).toBe(1250);
    expect(packCredits(25, 'pro')).toBe(3281);
    expect(packCredits(50, 'pro')).toBe(6750);
    expect(packCredits(100, 'pro')).toBe(13750);
  });
});

describe('persona pricing', () => {
  it('prices a persona generation with the margin formula', () => {
    // ceil(0.035 / 0.6 * 100) = 6 credits
    expect(personaGenCreditCost()).toBe(6);
    expect(PERSONA_GEN.id).toBe('persona');
  });

  it('fixes training at 350 credits with a positive margin over provider cost', () => {
    expect(PERSONA_TRAINING.creditCost).toBe(350);
    expect(PERSONA_TRAINING.creditCost / 100).toBeGreaterThan(PERSONA_TRAINING.providerCost);
    expect(PERSONA_TRAINING.minPhotos).toBe(5);
    expect(PERSONA_TRAINING.maxPhotos).toBe(20);
  });

  it('grants slots per plan', () => {
    expect(PERSONA_SLOTS.studio).toBe(2);
    expect(PERSONA_SLOTS.pro).toBe(5);
    expect(PERSONA_SLOTS.owner).toBe(5);
  });
});
