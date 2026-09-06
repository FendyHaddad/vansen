import { assertEquals } from 'jsr:@std/assert';
import { googleOmniAdapter } from './google-omni.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');

Deno.test('submit creates a background interaction and returns its id', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ id: 'int_abc', status: 'in_progress' });
  });
  try {
    const r = await googleOmniAdapter.submit({
      familyId: 'omni', op: 'generate', prompt: 'a cat', safetyId: 's',
      settings: { aspectRatio: '1:1', resolution: '720p', durationS: 4 }, mode: 't2v',
    });
    assertEquals(r.providerRef, 'int_abc');
    assertEquals(r.interactionId, 'int_abc');
    assertEquals(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assertEquals(calls[0].body.model, 'gemini-omni-flash-1.1');
    assertEquals(calls[0].body.background, true);
    assertEquals((calls[0].body.generation_config as { video_config: Record<string, unknown> }).video_config, {
      aspect_ratio: '1:1', resolution: '720p', duration_seconds: 4,
    });
    assertEquals(calls[0].body.previous_interaction_id, undefined);
  } finally {
    restore();
  }
});

Deno.test('edit passes previous_interaction_id', async () => {
  let body: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    body = JSON.parse(String(init?.body));
    return json({ id: 'int_2', status: 'in_progress' });
  });
  try {
    await googleOmniAdapter.submit({
      familyId: 'omni', op: 'generate', prompt: 'make it night', safetyId: 's',
      settings: { aspectRatio: '16:9' }, mode: 'edit', interactionId: 'int_abc',
    });
    assertEquals(body.previous_interaction_id, 'int_abc');
  } finally {
    restore();
  }
});

Deno.test('check maps in_progress / completed / failed', async () => {
  let restore = stubFetch(() => json({ id: 'int_abc', status: 'in_progress' }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), { state: 'running', phase: 'rendering' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({ id: 'int_abc', status: 'completed', outputs: [{ type: 'video', uri: 'https://files/o.mp4', mime_type: 'video/mp4' }] }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), {
      state: 'done', url: 'https://files/o.mp4', contentType: 'video/mp4', headers: { 'x-goog-api-key': 'test-key' },
    });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'int_abc', status: 'failed', error: { code: 'SAFETY', message: 'nope' } }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});
