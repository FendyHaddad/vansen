import { describe, expect, it } from 'vitest';
import {
  CREDIT_PACKS,
  EDIT_TOOLS,
  FLUX_DIMS,
  MODEL_FAMILIES,
  PERSONA_GEN,
  PERSONA_SLOTS,
  PERSONA_TRAINING,
  PLAN_CREDITS,
  STUDIO_MARGIN,
  VIDEO_DAILY_CAP_USD,
  creditCost,
  defaultSettings,
  GPT_REFERENCE_TOKENS,
  PROMPT_TOKEN_ALLOWANCE,
  providerCostWithInput,
  seedreamDims,
  editToolById,
  familyById,
  fluxDims,
  packCredits,
  personaGenCreditCost,
  qualitiesFor,
  resolutionsFor,
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
    // Nano Banana 2 Lite: 1120 tokens at $30/1M = $0.0336 for a 1K image.
    // Was 0.039 for gemini-2.5-flash-image, which Google shut down 2026-10-02.
    expect(nb.providerCost({ version: 'fast', aspectRatio: '1:1' })).toBeCloseTo(0.0336);
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

  it('gpt image is priced from measured output tokens, not a flat tier', () => {
    const gpt = familyById('gpt-image')!;
    const at = (version: string, quality: string, aspectRatio: string, resolution: string) =>
      gpt.providerCost({ version, aspectRatio, resolution, quality });
    const RATE = 30 / 1_000_000;

    // Every figure below is an output-token count read from OpenAI's own
    // calculator on 2026-09-22 (re-driven cell by cell the same day), times
    // the published $30/1M rate. Both 2.5 models share one token table.
    expect(at('2.5-flare', 'low', '1:1', '1K')).toBeCloseTo(196 * RATE, 6);
    expect(at('2.5-flare', 'medium', '1:1', '1K')).toBeCloseTo(439 * RATE, 6);
    expect(at('2.5-sunburst', 'high', '1:1', '1K')).toBeCloseTo(1756 * RATE, 6);
    expect(at('2.5-sunburst', 'max', '1:1', '1K')).toBeCloseTo(at('2.5-flare', 'max', '1:1', '1K'), 6);

    // The defect this table replaced: 2K was charged at the 1K price, so a 1:1
    // 2K image sold below cost. It must now cost more than the same image at 1K.
    expect(at('2.5-flare', 'medium', '1:1', '2K')).toBeCloseTo(892 * RATE, 6);
    expect(at('2.5-flare', 'max', '1:1', '2K')).toBeCloseTo(14272 * RATE, 6);
    expect(at('2.5-flare', 'max', '1:1', '2K')).toBeGreaterThan(at('2.5-flare', 'max', '1:1', '1K'));

    // Price tracks pixels, so the multiplier is not one number. 4K over 1K is
    // 2.19x at 1:1 and 3.52x at 16:9 — the flat 2.05x was wrong at both.
    expect(at('2.5-flare', 'max', '1:1', '4K') / at('2.5-flare', 'max', '1:1', '1K')).toBeCloseTo(2.19, 2);
    expect(at('2.5-flare', 'max', '16:9', '4K') / at('2.5-flare', 'max', '16:9', '1K')).toBeCloseTo(3.52, 2);
    expect(at('2.5-flare', 'xhigh', '16:9', '4K')).toBeCloseTo(5930 * RATE, 6);
  });

  it('gpt image offers only the two 2.5 models, Flare by default', () => {
    const gpt = familyById('gpt-image')!;
    // 1.5 and 2 were withdrawn 2026-09-22: version 2 medium is 2.5 high and
    // 2 high is 2.5 max at the same rate, so it sold nothing 2.5 does not.
    expect(gpt.capabilities.versions!.map((v) => v.value)).toEqual(['2.5-flare', '2.5-sunburst']);
    expect(defaultSettings(gpt).version).toBe('2.5-flare');
    // Neither version is capped: 2K and 4K everywhere, every quality everywhere.
    for (const version of ['2.5-flare', '2.5-sunburst']) {
      expect(resolutionsFor(gpt, '1:1', version).map((r) => r.value)).toEqual(['1K', '2K', '4K']);
      expect(qualitiesFor(gpt, version).map((q) => q.value)).toEqual([
        'low', 'medium', 'high', 'xhigh', 'max',
      ]);
    }
  });

  it('prices the prompt on every token-billed generation and a reference on top', () => {
    const gpt = familyById('gpt-image')!;
    const s = { version: '2.5-flare', aspectRatio: '1:1', resolution: '1K', quality: 'low' };
    const output = gpt.providerCost(s);
    const prompt = PROMPT_TOKEN_ALLOWANCE * (5 / 1_000_000);
    const reference = GPT_REFERENCE_TOKENS * (8 / 1_000_000);
    expect(providerCostWithInput(gpt, s)).toBeCloseTo(output + prompt, 8);
    expect(providerCostWithInput(gpt, s, { hasReference: true })).toBeCloseTo(
      output + prompt + reference,
      8,
    );
    // A reference costs more than a low-quality generation does; the credit
    // price has to move or every reference-driven draft sells below cost.
    expect(creditCost(gpt, s, { hasReference: true })).toBeGreaterThan(creditCost(gpt, s));
    expect(creditCost(gpt, s)).toBe(Math.ceil(((output + prompt) / (1 - STUDIO_MARGIN)) * 100));
  });

  it('flat-priced fal families charge nothing for a reference', () => {
    const seedream = familyById('seedream')!;
    const s = { version: '4', aspectRatio: '1:1', resolution: '1K' };
    expect(creditCost(seedream, s, { hasReference: true })).toBe(creditCost(seedream, s));
  });

  it('flux tiers follow fal’s published rate per version', () => {
    const flux = familyById('flux')!;
    const at = (version: string, resolution: string) => flux.providerCost({ version, aspectRatio: '1:1', resolution });
    // pro: $0.03 first MP + $0.015 per extra; flex $0.05/MP; max $0.07 + $0.03.
    expect(at('pro', '1MP')).toBeCloseTo(0.03);
    expect(at('pro', '2MP')).toBeCloseTo(0.045);
    expect(at('pro', '4MP')).toBeCloseTo(0.075);
    expect(at('flex', '2MP')).toBeCloseTo(0.1);
    expect(at('max', '1MP')).toBeCloseTo(0.07);
    expect(at('max', '4MP')).toBeCloseTo(0.16);
    expect(defaultSettings(flux).version).toBe('pro');
    expect(flux.capabilities.versions!.map((v) => v.value)).toEqual(['pro', 'flex', 'max']);
  });

  it('every flux size fits its megapixel tier in fal units and is divisible by 16', () => {
    // fal rounds UP to the nearest megapixel (1,048,576 px), so a 2MP size one
    // pixel over would bill as 3MP. pro/flex/max also want /16 edges.
    const tierPx: Record<string, number> = { '1MP': 1, '2MP': 2, '4MP': 4 };
    for (const [key, { width, height }] of Object.entries(FLUX_DIMS)) {
      const tier = key.split(':')[2];
      expect(width * height, key).toBeLessThanOrEqual(tierPx[tier] * 1_048_576);
      expect(width % 16, key).toBe(0);
      expect(height % 16, key).toBe(0);
      expect(width, key).toBeLessThanOrEqual(2048);
      expect(height, key).toBeLessThanOrEqual(2048);
    }
  });

  it('seedream versions price flat per image, 5 Pro by area tier', () => {
    const sd = familyById('seedream')!;
    const at = (version: string, resolution: string, aspectRatio = '1:1') =>
      sd.providerCost({ version, aspectRatio, resolution });
    expect(at('4', '4K')).toBeCloseTo(0.03);
    expect(at('4.5', '2K')).toBeCloseTo(0.04);
    expect(at('5-lite', '2K')).toBeCloseTo(0.035);
    // 5 Pro: $0.0675 up to 1536² px, $0.135 above. Every 1K size is under,
    // every 2K size is over.
    for (const aspectRatio of ['1:1', '4:3', '16:9']) {
      expect(at('5-pro', '1K', aspectRatio)).toBeCloseTo(0.0675);
      expect(at('5-pro', '2K', aspectRatio)).toBeCloseTo(0.135);
    }
    expect(defaultSettings(sd).version).toBe('4');
  });

  it('withholds the seedream tiers each endpoint cannot render', () => {
    const sd = familyById('seedream')!;
    const tiers = (version: string) => resolutionsFor(sd, '1:1', version).map((r) => r.value);
    expect(tiers('4')).toEqual(['1K', '2K', '4K']);
    expect(tiers('4.5')).toEqual(['2K', '4K']);
    expect(tiers('5-lite')).toEqual(['2K']);
    expect(tiers('5-pro')).toEqual(['1K', '2K']);
  });

  it('every seedream size we send is inside its endpoint’s pixel window', () => {
    const sd = familyById('seedream')!;
    const windows: Record<string, [number, number]> = {
      '4': [960 * 960, 4096 * 4096],
      '4.5': [2560 * 1440, 4096 * 4096],
      '5-lite': [2560 * 1440, 3072 * 3072],
      '5-pro': [1_048_576, 4_194_304],
    };
    for (const [version, [min, max]] of Object.entries(windows)) {
      for (const aspectRatio of sd.capabilities.aspectRatios) {
        for (const { value: resolution } of resolutionsFor(sd, aspectRatio, version)) {
          const { width, height } = seedreamDims({ version, aspectRatio, resolution });
          const px = width * height;
          expect(px, `${version} ${aspectRatio} ${resolution}`).toBeGreaterThanOrEqual(min);
          expect(px, `${version} ${aspectRatio} ${resolution}`).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it('prices xhigh and max above high on the 2.5 models', () => {
    const gpt = familyById('gpt-image')!;
    const at = (quality: string) =>
      gpt.providerCost({ version: '2.5-flare', aspectRatio: '1:1', resolution: '1K', quality });
    expect(at('xhigh')).toBeCloseTo(3122 * (30 / 1_000_000), 6);
    expect(at('max')).toBeCloseTo(7024 * (30 / 1_000_000), 6);
    expect(at('xhigh')).toBeGreaterThan(at('high'));
    expect(at('max')).toBeGreaterThan(at('xhigh'));
  });

  it('never prices an unknown quality as the cheapest step', () => {
    const gpt = familyById('gpt-image')!;
    // A bug upstream must not become a discount.
    const bogus = gpt.providerCost({
      version: '2.5-flare', aspectRatio: '1:1', resolution: '1K', quality: 'free-please',
    });
    const max = gpt.providerCost({
      version: '2.5-flare', aspectRatio: '1:1', resolution: '1K', quality: 'max',
    });
    expect(bogus).toBeCloseTo(max, 6);
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
    expect(s.version).toBe('2.5-flare');
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
    // FLUX.2 is priced as a flat tier, not per megapixel: $0.03 -> 5 credits.
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

/**
 * FLUX.2 clamps both edges to 2048, so the "4MP" label is only true at 1:1.
 * The tier is priced flat, which means an off-square 4MP would charge 20
 * credits for 2.36 megapixels — the tier is withheld instead of discounted.
 */
describe('FLUX resolution tiers match what the endpoint can produce', () => {
  const flux = () => familyById('flux')!;

  it('prices each tier the same at every aspect ratio', () => {
    for (const aspectRatio of ['1:1', '16:9', '9:16', '4:3', '3:4']) {
      expect(flux().providerCost({ aspectRatio, resolution: '1MP' })).toBeCloseTo(0.03);
      expect(flux().providerCost({ aspectRatio, resolution: '2MP' })).toBeCloseTo(0.045);
    }
    expect(flux().providerCost({ aspectRatio: '1:1', resolution: '4MP' })).toBeCloseTo(0.075);
    expect(creditCost(flux(), { aspectRatio: '1:1', resolution: '4MP' })).toBe(13);
  });

  it('offers 4MP at 1:1, where 2048x2048 really is 4 megapixels', () => {
    const values = resolutionsFor(flux(), '1:1').map((o) => o.value);
    expect(values).toEqual(['1MP', '2MP', '4MP']);
    const { width, height } = fluxDims({ aspectRatio: '1:1', resolution: '4MP' });
    expect((width * height) / 1_000_000).toBeGreaterThanOrEqual(4);
  });

  it('withholds 4MP at every ratio the clamp keeps below 4 megapixels', () => {
    for (const aspectRatio of ['16:9', '9:16', '4:3', '3:4']) {
      const values = resolutionsFor(flux(), aspectRatio).map((o) => o.value);
      expect(values).toEqual(['1MP', '2MP']);
      // The reason it is withheld, asserted rather than asserted-about.
      const { width, height } = fluxDims({ aspectRatio, resolution: '4MP' });
      expect((width * height) / 1_000_000).toBeLessThan(4);
    }
  });

  it('leaves families without an exclusion list untouched', () => {
    const seedream = familyById('seedream')!;
    for (const aspectRatio of seedream.capabilities.aspectRatios) {
      expect(resolutionsFor(seedream, aspectRatio)).toBe(seedream.capabilities.resolutions);
    }
  });

  it('never sells a tier whose real pixels cost more than the tier above', () => {
    // The trap the old table set: 4MP at 16:9 was 20 credits for 2.36MP,
    // while 2MP at 16:9 was 10 credits for 2.01MP.
    for (const aspectRatio of flux().capabilities.aspectRatios) {
      const offered = resolutionsFor(flux(), aspectRatio);
      const megapixels = offered.map((o) => {
        const { width, height } = fluxDims({ aspectRatio, resolution: o.value });
        return (width * height) / 1_000_000;
      });
      const perMp = offered.map(
        (o, i) => creditCost(flux(), { aspectRatio, resolution: o.value }) / megapixels[i],
      );
      // Paying more per megapixel for a bigger size is a tier nobody should pick.
      for (let i = 1; i < perMp.length; i++) expect(perMp[i]).toBeLessThanOrEqual(perMp[0] * 1.05);
    }
  });
});
