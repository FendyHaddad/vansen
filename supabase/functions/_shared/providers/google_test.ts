import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { googleAdapter } from './google.ts';
import { captureFetch, TINY_PNG_B64 } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(settings: Record<string, unknown>, over: Partial<SubmitCtx> = {}): SubmitCtx {
  const family = familyById('nano-banana')!;
  const op = String(over.op ?? 'generate');
  return {
    familyId: 'nano-banana',
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

function respondImage(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ inline_data: { mime_type: 'image/png', data: TINY_PNG_B64 } }] },
      }],
    }),
    { status: 200 },
  );
}

Deno.test('each version calls a different model url', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'fast', resolution: '1K' }));
  await googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'pro', resolution: '1K' }));
  cap.restore();
  assertNotEquals(cap.calls[0].url, cap.calls[1].url);
  assertEquals(cap.calls[0].url.includes('gemini-2.5-flash-image'), true);
  assertEquals(cap.calls[1].url.includes('gemini-3-pro-image'), true);
});

Deno.test('resolution and aspect ratio travel in imageConfig', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await googleAdapter.submit(ctx({ aspectRatio: '16:9', version: 'standard', resolution: '4K' }));
  cap.restore();
  const config = cap.calls[0].jsonBody!.generationConfig as Record<string, unknown>;
  assertEquals(config.imageConfig, { image_size: '4K', aspect_ratio: '16:9' });
});

Deno.test('a reference is sent inline on generate', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch((call) =>
    call.url.includes('generativelanguage') ? respondImage() : new Response(
      new Uint8Array([1, 2, 3]),
      { status: 200, headers: { 'content-type': 'image/png' } },
    )
  );
  await googleAdapter.submit(
    ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' }, {
      op: 'generate',
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('generativelanguage'))!;
  const parts = (apiCall.jsonBody!.contents as { parts: Record<string, unknown>[] }[])[0].parts;
  assertEquals(parts.length, 2);
  assertEquals(typeof parts[1].inline_data, 'object');
});

Deno.test('a response with no image throws rather than storing nothing', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  await assertRejects(
    () => googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' })),
    Error,
    'no image',
  );
  cap.restore();
});

Deno.test('a context with no normalized request is refused', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  await assertRejects(
    () =>
      googleAdapter.submit({
        familyId: 'nano-banana',
        op: 'generate',
        prompt: 'x',
        settings: { aspectRatio: '1:1' },
        safetyId: 'sha-test',
      } as SubmitCtx),
    Error,
    'normalized',
  );
});
