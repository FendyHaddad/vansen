import { assertEquals } from 'jsr:@std/assert';
import { familyById } from '../_shared/model-families.ts';
import { validateSettings } from './request-validation.ts';

Deno.test('accepts every catalogued combination for each family', () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const family = familyById(familyId)!;
    const caps = family.capabilities;
    for (const version of caps.versions?.map((v) => v.value) ?? [undefined]) {
      for (const resolution of caps.resolutions?.map((r) => r.value) ?? [undefined]) {
        for (const quality of caps.qualities?.map((q) => q.value) ?? [undefined]) {
          const result = validateSettings(family, {
            aspectRatio: caps.aspectRatios[0],
            version,
            resolution,
            quality,
          });
          assertEquals(result, null, `${familyId} ${version}/${resolution}/${quality}`);
        }
      }
    }
  }
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
  assertEquals(result?.allowed, ['1', '1.5', '2']);
});

Deno.test('rejects an unknown resolution', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, { aspectRatio: '1:1', resolution: '8MP' });
  assertEquals(result?.field, 'resolution');
});

Deno.test('rejects a version on a family that has none', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, {
    aspectRatio: '1:1',
    resolution: '1MP',
    version: '2',
  });
  assertEquals(result?.field, 'version');
  assertEquals(result?.allowed, []);
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
