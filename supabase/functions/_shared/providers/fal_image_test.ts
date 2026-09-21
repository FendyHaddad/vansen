import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { falAdapter } from './fal.ts';
import { captureFetch } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(
  familyId: string,
  settings: Record<string, unknown>,
  over: Partial<SubmitCtx> = {},
): SubmitCtx {
  const family = familyById(familyId)!;
  const op = String(over.op ?? 'generate');
  return {
    familyId,
    op,
    prompt: 'a red square',
    settings,
    safetyId: 'sha-test',
    normalized: normalizeGenerationRequest(family, op, settings as never, {
      hasReference: !!over.referenceUrl,
      hasMask: false,
    }),
    ...over,
  } as SubmitCtx;
}

function queued(): Response {
  return new Response(JSON.stringify({ request_id: 'req_1' }), { status: 200 });
}

Deno.test('flux: two resolutions produce two different payloads', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '1MP' }));
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '4MP' }));
  cap.restore();
  assertNotEquals(
    JSON.stringify(cap.calls[0].jsonBody),
    JSON.stringify(cap.calls[1].jsonBody),
    '4MP costs four times 1MP and must not send the same request',
  );
});

Deno.test('flux: the aspect ratio travels inside image_size, the name the record verified', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('flux', { aspectRatio: '16:9', resolution: '1MP' }));
  cap.restore();
  const body = cap.calls[0].jsonBody!;
  assertEquals(body.image_size, { width: 1344, height: 752 });
  // fal accepts no aspect_ratio on any image endpoint; sending one is a silent
  // no-op that hid this defect for the whole life of the family.
  assertEquals('aspect_ratio' in body, false);
});

Deno.test('flux: calls the endpoint the catalog actually sells', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '1MP' }));
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '1MP', version: 'max' }));
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('fal-ai/flux-2'), true);
  assertEquals(cap.calls[1].url.endsWith('fal-ai/flux-2-max'), true);
});

Deno.test('seedream: a reference switches to the edit slug of the SAME version', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(
    ctx('seedream', { aspectRatio: '1:1', resolution: '1K' }, {
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  await falAdapter.submit(
    ctx('seedream', { aspectRatio: '1:1', resolution: '2K', version: '5-pro' }, {
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('fal-ai/bytedance/seedream/v4/edit'), true);
  assertEquals(cap.calls[1].url.endsWith('bytedance/seedream/v5/pro/edit'), true);
  assertEquals(
    (cap.calls[0].jsonBody!.image_urls as string[])[0],
    'https://fake.storage/uploads/u/1.png',
  );
});

Deno.test('seedream: no reference uses the text-to-image slug', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('seedream', { aspectRatio: '1:1', resolution: '1K' }));
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('/text-to-image'), true);
});

Deno.test('seedream: the resolution reaches the wire', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('seedream', { aspectRatio: '1:1', resolution: '1K' }));
  await falAdapter.submit(ctx('seedream', { aspectRatio: '1:1', resolution: '4K' }));
  cap.restore();
  assertNotEquals(
    JSON.stringify(cap.calls[0].jsonBody!.image_size),
    JSON.stringify(cap.calls[1].jsonBody!.image_size),
  );
});

// Owner decision 2026-09-21: fal-ai/flux-2 documents no reference parameter, so
// FLUX stops claiming imageInput. A reference must never be smuggled into the
// payload under a name the endpoint ignores.
Deno.test('flux: a reference is NOT sent, because flux-2 has no reference input', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(
    ctx('flux', { aspectRatio: '1:1', resolution: '1MP' }, {
      op: 'generate',
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  const body = cap.calls[0].jsonBody!;
  assertEquals('image_url' in body, false);
  assertEquals('image_urls' in body, false);
});

Deno.test('the edit tools and the upscaler are untouched by normalization', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit({
    familyId: 'edit-bg',
    op: 'edit',
    prompt: '',
    settings: {},
    safetyId: 'sha-test',
    referenceUrl: 'https://fake.storage/media/a.png',
  } as SubmitCtx);
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('fal-ai/birefnet/v2'), true);
  assertEquals(cap.calls[0].jsonBody!.image_url, 'https://fake.storage/media/a.png');
});

Deno.test('a normalized image family with no normalized request is refused', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  let threw = '';
  try {
    await falAdapter.submit({
      familyId: 'flux',
      op: 'generate',
      prompt: 'x',
      settings: { aspectRatio: '1:1' },
      safetyId: 'sha-test',
    } as SubmitCtx);
  } catch (e) {
    threw = (e as Error).message;
  }
  cap.restore();
  assertEquals(threw.includes('normalized'), true, `expected a refusal, got "${threw}"`);
});
