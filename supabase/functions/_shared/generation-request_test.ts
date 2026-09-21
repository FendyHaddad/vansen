import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { familyById } from './model-families.ts';
import { normalizeGenerationRequest, quote, QUOTE_VERSION } from './generation-request.ts';

function norm(familyId: string, settings: Record<string, unknown>, op = 'generate') {
  const family = familyById(familyId)!;
  return normalizeGenerationRequest(family, op, settings as never, {
    hasReference: false,
    hasMask: false,
  });
}

Deno.test('THE BUG: gpt-image v1.5 and v2-at-4K must not send the same request', () => {
  // Was version '1' until 2026-09-22, when it was withdrawn from the offer.
  // 1.5 carries the same shape of the bug: it is capped at 1K, so a 4K
  // selection on it must not silently become the same request as a real 4K.
  const v1 = norm('gpt-image', { aspectRatio: '1:1', version: '1.5', quality: 'medium', resolution: '1K' });
  const v2 = norm('gpt-image', { aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '4K' });
  const family = familyById('gpt-image')!;
  const priceV1 = quote(v1, family).credits;
  const priceV2 = quote(v2, family).credits;

  assertNotEquals(priceV1, priceV2, 'precondition: the catalog prices these differently');
  assertNotEquals(
    JSON.stringify({ m: v1.providerModel, s: v1.providerSettings }),
    JSON.stringify({ m: v2.providerModel, s: v2.providerSettings }),
    'two prices must mean two different provider requests',
  );
});

Deno.test('THE BUG: flux resolutions must not send the same request', () => {
  const one = norm('flux', { aspectRatio: '1:1', resolution: '1MP' });
  const four = norm('flux', { aspectRatio: '1:1', resolution: '4MP' });
  const family = familyById('flux')!;
  assertNotEquals(quote(one, family).credits, quote(four, family).credits);
  assertNotEquals(
    JSON.stringify(one.providerSettings),
    JSON.stringify(four.providerSettings),
  );
});

Deno.test('seedream exposes only verified differentiating resolutions', () => {
  const family = familyById('seedream')!;
  const selections = family.capabilities.resolutions?.map((r) => r.value) ?? [];
  const normalized = selections.map((resolution) => norm('seedream', { aspectRatio: '1:1', resolution }));
  const requests = normalized.map((n) => JSON.stringify(n.providerSettings));
  assertEquals(new Set(requests).size, selections.length);
  for (const n of normalized) {
    assertEquals(quote(n, family).providerCostUsd, family.providerCost(n.settings));
  }
});

Deno.test('CONTROL: nano-banana already maps version and resolution', () => {
  const fast = norm('nano-banana', { aspectRatio: '1:1', version: 'fast', resolution: '1K' });
  const pro = norm('nano-banana', { aspectRatio: '1:1', version: 'pro', resolution: '4K' });
  assertEquals(fast.providerModel, 'gemini-3.1-flash-lite-image');
  assertEquals(pro.providerModel, 'gemini-3-pro-image');
  assertEquals(fast.providerSettings.image_size, '1K');
  assertEquals(pro.providerSettings.image_size, '4K');
});

Deno.test('the same provider request always prices the same', () => {
  const a = norm('nano-banana', { aspectRatio: '1:1', version: 'standard', resolution: '2K' });
  const b = norm('nano-banana', { aspectRatio: '1:1', version: 'standard', resolution: '2K' });
  const family = familyById('nano-banana')!;
  assertEquals(
    JSON.stringify({ m: a.providerModel, s: a.providerSettings }),
    JSON.stringify({ m: b.providerModel, s: b.providerSettings }),
  );
  assertEquals(quote(a, family).credits, quote(b, family).credits);
});

Deno.test('every normalized request carries its versions', () => {
  const n = norm('flux', { aspectRatio: '1:1', resolution: '1MP' });
  assertEquals(n.quoteVersion, QUOTE_VERSION);
  assertEquals(typeof n.catalogVersion, 'string');
});

Deno.test('a reference is recorded on generate, not only on edit', () => {
  const family = familyById('gpt-image')!;
  const n = normalizeGenerationRequest(
    family,
    'generate',
    { aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' } as never,
    { hasReference: true, hasMask: false },
  );
  assertEquals(n.hasReference, true);
});

Deno.test('the credit price equals the catalog creditCost for the same settings', () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const family = familyById(familyId)!;
    const settings = {
      aspectRatio: family.capabilities.aspectRatios[0],
      version: family.capabilities.versions?.[0]?.value,
      resolution: family.capabilities.resolutions?.[0]?.value,
      quality: family.capabilities.qualities?.[0]?.value,
    };
    const n = normalizeGenerationRequest(family, 'generate', settings as never, {
      hasReference: false,
      hasMask: false,
    });
    const { credits, providerCostUsd } = quote(n, family);
    assertEquals(providerCostUsd, family.providerCost(settings as never));
    assertEquals(credits > 0, true, `${familyId} must have a positive price`);
  }
});

// ── Added beyond the plan: the fal aspect-ratio defect the capability record
// found. No fal image endpoint accepts `aspect_ratio`, so a normalized fal
// request must carry the ratio inside `image_size` and must NOT emit a key the
// provider silently drops.
Deno.test('fal families never emit aspect_ratio, which fal ignores', () => {
  for (const familyId of ['flux', 'seedream']) {
    const n = norm(familyId, { aspectRatio: '16:9', resolution: familyById(familyId)!.capabilities.resolutions![0].value });
    assertEquals(
      'aspect_ratio' in n.providerSettings,
      false,
      `${familyId} must not send aspect_ratio`,
    );
  }
});

Deno.test('a fal aspect ratio changes the request, because image_size carries it', () => {
  for (const familyId of ['flux', 'seedream']) {
    const res = familyById(familyId)!.capabilities.resolutions![0].value;
    const square = norm(familyId, { aspectRatio: '1:1', resolution: res });
    const wide = norm(familyId, { aspectRatio: '16:9', resolution: res });
    assertNotEquals(
      JSON.stringify(square.providerSettings),
      JSON.stringify(wide.providerSettings),
      `${familyId} aspect ratio must reach the provider`,
    );
  }
});

Deno.test('gpt-image 2K and 4K are refused on versions that cannot render them', () => {
  let threw = '';
  try {
    norm('gpt-image', { aspectRatio: '1:1', version: '1', quality: 'medium', resolution: '4K' });
  } catch (e) {
    threw = (e as Error).message;
  }
  assertEquals(threw.startsWith('unsupported_'), true, `expected a refusal, got "${threw}"`);
});

/**
 * Every size we can put on the wire has to satisfy OpenAI's own validator.
 *
 * 16:9:1K and 9:16:1K were 1024x576 and 576x1024 — 589,824 px against a
 * documented floor of 655,360 — so an ordinary 16:9-at-1K request on the
 * default version of a live family named a size the API does not accept. A
 * table nobody checks against the published rules is how that survives.
 *
 * Rules, from platform.openai.com/docs/guides/image-generation (2026-09-22):
 * both edges divisible by 16, neither over 3840, aspect between 1:3 and 3:1,
 * total pixels between 655,360 and 8,294,400 inclusive.
 */
Deno.test('every gpt-image size we can send satisfies the published size rules', async () => {
  const caps = JSON.parse(
    await Deno.readTextFile(new URL('./provider-capabilities.json', import.meta.url)),
  ) as { gptSizes: Record<string, string>; gptStandardSizes: Record<string, string> };

  const sizes = [...Object.entries(caps.gptSizes), ...Object.entries(caps.gptStandardSizes)];
  for (const [key, size] of sizes) {
    const [w, h] = size.split('x').map(Number);
    const pixels = w * h;
    const ratio = Math.max(w / h, h / w);
    assertEquals(w % 16, 0, `${key} ${size}: width not divisible by 16`);
    assertEquals(h % 16, 0, `${key} ${size}: height not divisible by 16`);
    assertEquals(w <= 3840 && h <= 3840, true, `${key} ${size}: edge over 3840`);
    assertEquals(ratio <= 3, true, `${key} ${size}: aspect beyond 3:1`);
    assertEquals(pixels >= 655_360, true, `${key} ${size}: ${pixels}px under the 655,360 floor`);
    assertEquals(pixels <= 8_294_400, true, `${key} ${size}: ${pixels}px over the 4K ceiling`);
  }
});

Deno.test('16:9 at 1K sends a size above the pixel floor', () => {
  const r = norm('gpt-image', { version: '2', aspectRatio: '16:9', resolution: '1K', quality: 'low' });
  assertEquals(r.providerSettings.size, '1280x720');
  const r2 = norm('gpt-image', { version: '2', aspectRatio: '9:16', resolution: '1K', quality: 'low' });
  assertEquals(r2.providerSettings.size, '720x1280');
});

/** xhigh and max reach the provider only on the versions that accept them. */
Deno.test('gpt-image 2.5 carries xhigh and max through to the provider', () => {
  for (const quality of ['xhigh', 'max']) {
    const r = norm('gpt-image', {
      version: '2.5-sunburst', aspectRatio: '1:1', resolution: '2K', quality,
    });
    assertEquals(r.providerModel, 'gpt-image-2.5-sunburst');
    assertEquals(r.providerSettings.quality, quality);
  }
});
