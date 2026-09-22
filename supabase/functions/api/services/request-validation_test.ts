import { assertEquals } from 'jsr:@std/assert';
import { familyById, qualitiesFor, resolutionsFor } from '../_shared/model-families.ts';
import { validateSettings } from './request-validation.ts';

Deno.test('accepts every catalogued combination for each family', () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const family = familyById(familyId)!;
    const caps = family.capabilities;
    // Every ratio, not just the first: which tiers exist can depend on it.
    for (const aspectRatio of caps.aspectRatios) {
      for (const version of caps.versions?.map((v) => v.value) ?? [undefined]) {
        // Per VERSION as well as per ratio. Enumerating the family-wide lists
        // here is what let GPT Image 2.5 ship offering 1K only: the test passed
        // because it never asked what a specific version actually allows.
        const offered = caps.resolutions
          ? resolutionsFor(family, aspectRatio, version).map((r) => r.value)
          : [undefined];
        const qualities = caps.qualities
          ? qualitiesFor(family, version).map((q) => q.value)
          : [undefined];
        for (const resolution of offered) {
          for (const quality of qualities) {
            const result = validateSettings(family, { aspectRatio, version, resolution, quality });
            const where = `${familyId} ${aspectRatio} ${version}/${resolution}/${quality}`;
            assertEquals(result, null, where);
          }
        }
      }
    }
  }
});

/**
 * xhigh and max exist on both GPT Image 2.5 models. A stale client that sends
 * one of the withdrawn versions (1.5, 2) must be refused here, because this is
 * where the charge happens — the provider would reject or we would price a
 * model we no longer sell.
 */
Deno.test('accepts xhigh and max on both 2.5 models and refuses withdrawn versions', () => {
  const family = familyById('gpt-image')!;
  for (const version of ['2.5-flare', '2.5-sunburst']) {
    for (const quality of ['xhigh', 'max']) {
      assertEquals(validateSettings(family, { aspectRatio: '1:1', version, quality }), null);
    }
  }
  for (const version of ['1', '1.5', '2']) {
    const result = validateSettings(family, { aspectRatio: '1:1', version, quality: 'medium' });
    assertEquals(result?.field, 'version', version);
  }
});

/**
 * Seedream's endpoints have different pixel windows, so the tiers differ per
 * version. A stale client asking 5 Lite for 4K, or 4.5 for 1K, is refused
 * before the charge rather than after fal rejects the size.
 */
Deno.test('refuses a seedream resolution the selected version cannot render', () => {
  const family = familyById('seedream')!;
  const cases: [string, string][] = [['4.5', '1K'], ['5-lite', '1K'], ['5-lite', '4K'], ['5-pro', '4K']];
  for (const [version, resolution] of cases) {
    const result = validateSettings(family, { aspectRatio: '1:1', version, resolution });
    assertEquals(result?.field, 'resolution', `${version}/${resolution}`);
  }
  assertEquals(validateSettings(family, { aspectRatio: '1:1', version: '4', resolution: '4K' }), null);
  assertEquals(validateSettings(family, { aspectRatio: '1:1', version: '5-pro', resolution: '2K' }), null);
});

/**
 * The composer hides the 4MP chip off-square, but a stale web client or an old
 * mobile build does not know that. The charge happens on this side, so the
 * refusal has to happen on this side.
 */
Deno.test('refuses a resolution tier the aspect ratio cannot deliver', () => {
  const family = familyById('flux')!;
  for (const aspectRatio of ['16:9', '9:16', '4:3', '3:4']) {
    const result = validateSettings(family, { aspectRatio, resolution: '4MP' });
    assertEquals(result?.field, 'resolution', aspectRatio);
    assertEquals(result?.allowed, ['1MP', '2MP'], aspectRatio);
  }
  assertEquals(validateSettings(family, { aspectRatio: '1:1', resolution: '4MP' }), null);
});

Deno.test('an unknown aspect ratio is named as the aspect ratio, not the tier', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, { aspectRatio: '21:9', resolution: '4MP' });
  assertEquals(result?.field, 'aspectRatio');
});

Deno.test('rejects an unknown version', () => {
  const family = familyById('gpt-image')!;
  const result = validateSettings(family, {
    aspectRatio: '1:1',
    version: '9',
    quality: 'medium',
    resolution: '1K',
  });
  assertEquals(result?.field, 'version');
  assertEquals(result?.allowed, ['2.5-flare', '2.5-sunburst']);
});

Deno.test('rejects an unknown resolution', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, { aspectRatio: '1:1', resolution: '8MP' });
  assertEquals(result?.field, 'resolution');
});

Deno.test('rejects a version on a family that has none', () => {
  // Every image family now carries versions, so build a versionless one.
  const flux = familyById('flux')!;
  const family = { ...flux, capabilities: { ...flux.capabilities, versions: undefined } };
  const result = validateSettings(family, {
    aspectRatio: '1:1',
    resolution: '1MP',
    version: '2',
  });
  assertEquals(result?.field, 'version');
  assertEquals(result?.allowed, []);
});

Deno.test('flux accepts its three versions and refuses withdrawn or unknown ones', () => {
  const family = familyById('flux')!;
  for (const version of ['pro', 'flex', 'max']) {
    assertEquals(validateSettings(family, { aspectRatio: '1:1', resolution: '1MP', version }), null);
  }
  for (const version of ['dev', 'schnell']) {
    const result = validateSettings(family, { aspectRatio: '1:1', resolution: '1MP', version });
    assertEquals(result?.field, 'version', version);
  }
});

Deno.test('rejects an unsupported aspect ratio', () => {
  const family = familyById('seedream')!;
  const result = validateSettings(family, { aspectRatio: '21:9', resolution: '1K' });
  assertEquals(result?.field, 'aspectRatio');
});

Deno.test('rejects a duration the video family does not offer', () => {
  const family = familyById('kling')!;
  const result = validateSettings(family, {
    aspectRatio: '16:9',
    mode: 't2v',
    durationS: 7,
  });
  assertEquals(result?.field, 'durationS');
});

Deno.test('accepts a duration the video family does offer', () => {
  const family = familyById('kling')!;
  const durations = family.capabilities.durations!;
  const result = validateSettings(family, {
    aspectRatio: '16:9',
    mode: 't2v',
    durationS: durations[0],
  });
  assertEquals(result, null);
});

Deno.test('rejects audio on a family whose audio is not selectable', () => {
  const family = familyById('seedance')!;
  const caps = family.capabilities;
  if (caps.audio === 'selectable') return;
  const result = validateSettings(family, {
    aspectRatio: '16:9',
    mode: 't2v',
    durationS: caps.durations![0],
    audio: 'voice',
  });
  assertEquals(result?.field, 'audio');
});
