import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { googleAdapter } from './google.ts';
import { captureFetch, silenceUsageLog, TINY_PNG_B64 } from './testing/capture.ts';
import { classifyProviderError, ProviderError } from './provider-errors.ts';
import type { SubmitCtx } from './types.ts';

// Every successful submit logs its token usage; that line is asserted once,
// below, and is noise everywhere else.
silenceUsageLog();

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
  assertEquals(cap.calls[0].url.includes('gemini-3.1-flash-lite-image'), true);
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
  // The instruction follows the image it refers to.
  assertEquals(typeof parts[0].inline_data, 'object');
  assertEquals(parts[1].text, 'a red square');
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

// Google has answered and nothing is in flight, so there is nothing to
// reconcile: a retryable class would leave the charge held forever.
Deno.test('a finished answer with no image is terminal and names the finish reason', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(() =>
    new Response(
      JSON.stringify({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }),
      { status: 200 },
    )
  );
  const err = await assertRejects(
    () => googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' })),
    ProviderError,
    'IMAGE_SAFETY',
  );
  cap.restore();
  assertEquals(classifyProviderError(err), 'terminal');
});

Deno.test('a blocked prompt with no candidates is terminal and names the block reason', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(() =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), {
      status: 200,
    })
  );
  const err = await assertRejects(
    () => googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' })),
    ProviderError,
    'PROHIBITED_CONTENT',
  );
  cap.restore();
  assertEquals(classifyProviderError(err), 'terminal');
});

Deno.test('a large reference is sent as exact base64', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 31) % 256);
  const cap = captureFetch((call) =>
    call.url.includes('generativelanguage') ? respondImage() : new Response(
      bytes,
      { status: 200, headers: { 'content-type': 'image/jpeg' } },
    )
  );
  await googleAdapter.submit(
    ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' }, {
      referenceUrl: 'https://fake.storage/uploads/u/big.jpg',
    }),
  );
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('generativelanguage'))!;
  const parts = (apiCall.jsonBody!.contents as { parts: Record<string, unknown>[] }[])[0].parts;
  const inline = parts[0].inline_data as { mime_type: string; data: string };
  assertEquals(inline.mime_type, 'image/jpeg');
  assertEquals(Uint8Array.from(atob(inline.data), (c) => c.charCodeAt(0)), bytes);
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

function personaCtx(): SubmitCtx {
  return {
    familyId: 'persona', op: 'generate', prompt: 'wrapped prompt', settings: { aspectRatio: '3:4' },
    safetyId: 's',
    normalized: {
      quoteVersion: 1, catalogVersion: 'x', familyId: 'persona', op: 'generate',
      providerModel: 'gemini-3-pro-image',
      providerSettings: { image_size: '4K', aspect_ratio: '3:4' },
      settings: { aspectRatio: '3:4' }, hasReference: true, hasMask: false,
    },
    personaPhotos: [
      { slot: 'front', url: 'https://x/1' }, { slot: 'left_three_quarter', url: 'https://x/2' },
      { slot: 'right_three_quarter', url: 'https://x/3' }, { slot: 'left_profile', url: 'https://x/4' },
      { slot: 'right_profile', url: 'https://x/5' },
    ],
  };
}

function personaResponder(photo: (url: string) => Response) {
  return (call: { url: string }) => {
    if (call.url.includes(':generateContent')) {
      return Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }] } }],
        usageMetadata: { promptTokenCount: 3600, thoughtsTokenCount: 1500, candidatesTokenCount: 2000 },
      });
    }
    return photo(call.url);
  };
}

const JPEG = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });

Deno.test('google: persona photos are sent labelled, in slot order, before the prompt', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(personaResponder(JPEG));
  await googleAdapter.submit(personaCtx());
  cap.restore();
  const body = cap.calls.find((c) => c.url.includes(':generateContent'))!.jsonBody!;
  const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0].parts;
  assertEquals(parts.length, 11, '5 × (label + image) + prompt');
  assertEquals(parts[0].text, 'Image 1: front');
  assertEquals('inline_data' in parts[1], true);
  assertEquals(parts[2].text, 'Image 2: left three quarter');
  assertEquals(parts[8].text, 'Image 5: right profile');
  assertEquals(parts[10].text, 'wrapped prompt');
  // The photos were fetched in slot order.
  assertEquals(
    cap.calls.filter((c) => !c.url.includes(':generateContent')).map((c) => c.url),
    ['https://x/1', 'https://x/2', 'https://x/3', 'https://x/4', 'https://x/5'],
  );
  const config = body.generationConfig as Record<string, unknown>;
  assertEquals(config.imageConfig, { image_size: '4K', aspect_ratio: '3:4' });
  assertEquals(cap.calls.find((c) => c.url.includes(':generateContent'))!.url.includes('gemini-3-pro-image'), true);
});

Deno.test('google: a persona photo that cannot be read fails before the model is called', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(personaResponder((url) =>
    url === 'https://x/3' ? new Response('gone', { status: 404 }) : JPEG()
  ));
  const err = await assertRejects(
    () => googleAdapter.submit(personaCtx()),
    ProviderError,
    'persona photo right_three_quarter unavailable',
  );
  cap.restore();
  // Known-not-submitted: terminal, so dispatch refunds instead of reconciling.
  assertEquals(classifyProviderError(err), 'terminal');
  assertEquals(cap.calls.some((c) => c.url.includes(':generateContent')), false);
});

Deno.test('google: usage is logged with the model and image size', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(personaResponder(JPEG));
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  try {
    await googleAdapter.submit(personaCtx());
  } finally {
    console.log = original;
    cap.restore();
  }
  const usage = logged.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).find((l) => l?.event === 'google_usage');
  assertEquals(usage, {
    event: 'google_usage', model: 'gemini-3-pro-image', imageSize: '4K',
    usage: { promptTokenCount: 3600, thoughtsTokenCount: 1500, candidatesTokenCount: 2000 },
  });
});
