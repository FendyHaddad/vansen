import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { googleVideoAdapter, veoModelFor } from './google-video.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');

Deno.test('veoModelFor maps version to model id', () => {
  assertEquals(veoModelFor('standard'), 'veo-3.1-generate-preview');
  assertEquals(veoModelFor('fast'), 'veo-3.1-fast-generate-preview');
  assertEquals(veoModelFor('lite'), 'veo-3.1-lite-generate-preview');
  assertEquals(veoModelFor(undefined), 'veo-3.1-generate-preview');
});

Deno.test('submit posts predictLongRunning and returns the operation name', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ name: 'models/veo-3.1-generate-preview/operations/op123' });
  });
  try {
    const r = await googleVideoAdapter.submit({
      familyId: 'veo', op: 'generate', prompt: 'a fox', safetyId: 's',
      settings: { aspectRatio: '9:16', resolution: '1080p', durationS: 6, version: 'standard' },
      mode: 't2v',
    });
    assertEquals(r.providerRef, 'models/veo-3.1-generate-preview/operations/op123');
    assertEquals(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    const body = calls[0].body as { instances: { prompt: string }[]; parameters: Record<string, unknown> };
    assertEquals(body.instances[0].prompt, 'a fox');
    assertEquals(body.parameters.aspectRatio, '9:16');
    assertEquals(body.parameters.resolution, '1080p');
    assertEquals(body.parameters.durationSeconds, 6);
  } finally {
    restore();
  }
});

Deno.test('submit rejects unsupported mode before any network call', async () => {
  const restore = stubFetch(() => {
    throw new Error('should not fetch');
  });
  try {
    await assertRejects(
      () => googleVideoAdapter.submit({ familyId: 'veo', op: 'generate', prompt: 'x', safetyId: 's', settings: {}, mode: 'edit' }),
      Error,
      'unsupported_mode',
    );
  } finally {
    restore();
  }
});

Deno.test('check maps running / done-url / failed', async () => {
  let restore = stubFetch(() => json({ name: 'op', done: false }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'running', phase: 'rendering' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({
      name: 'op', done: true,
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files/v.mp4' } }] } },
    }));
  try {
    const r = await googleVideoAdapter.check('models/x/operations/op');
    assertEquals(r, {
      state: 'done', url: 'https://files/v.mp4', contentType: 'video/mp4',
      headers: { 'x-goog-api-key': 'test-key' },
    });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ name: 'op', done: true, error: { message: 'blocked by safety' } }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({ name: 'op', done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, generatedSamples: [] } } }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});
