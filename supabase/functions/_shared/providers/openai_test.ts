import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { openaiAdapter } from './openai.ts';
import { captureFetch, TINY_PNG_B64 } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(settings: Record<string, unknown>, over: Partial<SubmitCtx> = {}): SubmitCtx {
  const family = familyById('gpt-image')!;
  const op = String(over.op ?? 'generate');
  return {
    familyId: 'gpt-image',
    op,
    prompt: 'a red square',
    settings,
    safetyId: 'sha-test',
    normalized: normalizeGenerationRequest(family, op, settings as never, {
      hasReference: !!over.referenceUrl,
      hasMask: !!over.maskPngBase64,
    }),
    ...over,
  } as SubmitCtx;
}

function respondImage(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), { status: 200 });
}

const BASE = { aspectRatio: '1:1', version: '2.5-flare', quality: 'medium', resolution: '1K' };

Deno.test('the selected version reaches the wire as a distinct model', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ ...BASE, version: '2.5-flare' }));
  await openaiAdapter.submit(ctx({ ...BASE, version: '2.5-sunburst' }));
  cap.restore();
  assertEquals(cap.calls[0].jsonBody?.model, 'gpt-image-2.5-flare');
  assertEquals(cap.calls[1].jsonBody?.model, 'gpt-image-2.5-sunburst');
  // Two offered versions must be two distinct models on the wire; two
  // versions that collapse to one model are two prices for one product.
  assertEquals(new Set(cap.calls.map((c) => c.jsonBody?.model)).size, 2);
});

Deno.test('the selected resolution reaches the wire as a distinct size', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ ...BASE, resolution: '1K' }));
  await openaiAdapter.submit(ctx({ ...BASE, resolution: '4K' }));
  cap.restore();
  assertNotEquals(cap.calls[0].jsonBody?.size, cap.calls[1].jsonBody?.size);
  assertEquals(cap.calls[1].jsonBody?.size, '2160x2160');
});

Deno.test('the selected quality reaches the wire', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ ...BASE, quality: 'high' }));
  cap.restore();
  assertEquals(cap.calls[0].jsonBody?.quality, 'high');
});

Deno.test('R28: a reference on GENERATE uses the edits endpoint and sends the image', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch((call) =>
    call.url.includes('/images/') && call.method === 'POST'
      ? respondImage()
      : new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
  );
  await openaiAdapter.submit(
    ctx(BASE, { op: 'generate', referenceUrl: 'https://fake.storage/uploads/u/1.png' }),
  );
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('api.openai.com'))!;
  assertEquals(apiCall.url, 'https://api.openai.com/v1/images/edits');
  assertEquals(typeof apiCall.formBody?.get('image'), 'object');
});

Deno.test('no reference still uses the generations endpoint', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx(BASE));
  cap.restore();
  assertEquals(cap.calls[0].url, 'https://api.openai.com/v1/images/generations');
});

Deno.test('the safety id is always attached', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx(BASE));
  cap.restore();
  assertEquals(cap.calls[0].jsonBody?.user, 'sha-test');
});

Deno.test('a provider error surfaces its status', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('rate limited', { status: 429 }));
  await assertRejects(() => openaiAdapter.submit(ctx(BASE)), Error, '429');
  cap.restore();
});

Deno.test('a context with no normalized request is refused, not silently defaulted', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const bare = {
    familyId: 'gpt-image',
    op: 'generate',
    prompt: 'x',
    settings: { aspectRatio: '1:1' },
    safetyId: 'sha-test',
  } as SubmitCtx;
  await assertRejects(() => openaiAdapter.submit(bare), Error, 'normalized');
});

Deno.test('the mask still travels on a masked edit', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch((call) =>
    call.url.includes('api.openai.com')
      ? respondImage()
      : new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
  );
  await openaiAdapter.submit(ctx(BASE, {
    op: 'edit',
    referenceUrl: 'https://fake.storage/uploads/u/1.png',
    maskPngBase64: `data:image/png;base64,${TINY_PNG_B64}`,
  }));
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('api.openai.com'))!;
  assertEquals(typeof apiCall.formBody?.get('mask'), 'object');
});
