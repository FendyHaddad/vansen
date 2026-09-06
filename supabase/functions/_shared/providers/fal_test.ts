import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { falAdapter, videoPayloadFor, videoSlugFor } from './fal.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('FAL_API_KEY', 'fal-test');

const base = { op: 'generate', prompt: 'surf', safetyId: 's' };

Deno.test('kling slugs and payload', () => {
  const t2v = { ...base, familyId: 'kling', settings: { aspectRatio: '16:9', durationS: 10, audio: 'on' }, mode: 't2v' as const };
  assertEquals(videoSlugFor(t2v), 'fal-ai/kling-video/v3/pro/text-to-video');
  assertEquals(videoPayloadFor(t2v), { prompt: 'surf', duration: '10', aspect_ratio: '16:9', generate_audio: true, voice: false });

  const i2v = { ...t2v, mode: 'i2v' as const, referenceUrls: ['https://s/a.png'], settings: { ...t2v.settings, audio: 'voice' } };
  assertEquals(videoSlugFor(i2v), 'fal-ai/kling-video/v3/pro/image-to-video');
  assertEquals(videoPayloadFor(i2v), { prompt: 'surf', duration: '10', image_url: 'https://s/a.png', generate_audio: true, voice: true });

  const kf = { ...i2v, mode: 'keyframes' as const, referenceUrls: ['https://s/a.png', 'https://s/b.png'] };
  assertEquals(videoPayloadFor(kf).tail_image_url, 'https://s/b.png');
  assertThrows(() => videoSlugFor({ ...t2v, mode: 'ref2v' }), Error, 'unsupported_mode');
});

Deno.test('seedance slugs and payload', () => {
  const t2v = { ...base, familyId: 'seedance', settings: { aspectRatio: '9:16', resolution: '480p', durationS: 5 }, mode: 't2v' as const };
  assertEquals(videoSlugFor(t2v), 'bytedance/seedance-2.5/text-to-video');
  assertEquals(videoPayloadFor(t2v), { prompt: 'surf', duration: '5', aspect_ratio: '9:16', resolution: '480p' });
  const ref = { ...t2v, mode: 'ref2v' as const, referenceUrls: ['https://s/a.png', 'https://s/b.png'] };
  assertEquals(videoSlugFor(ref), 'bytedance/seedance-2.5/reference-to-video');
  assertEquals(videoPayloadFor(ref).reference_image_urls, ['https://s/a.png', 'https://s/b.png']);
  assertThrows(() => videoSlugFor({ ...t2v, mode: 'keyframes' }), Error, 'unsupported_mode');
});

Deno.test('check surfaces queue position and video url', async () => {
  const ref = JSON.stringify({
    statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status',
    responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1',
  });
  let restore = stubFetch(() => json({ status: 'IN_QUEUE', queue_position: 3 }));
  try {
    assertEquals(await falAdapter.check(ref), { state: 'running', phase: 'queued', queuePosition: 3 });
  } finally {
    restore();
  }
  restore = stubFetch((url) =>
    url.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({ video: { url: 'https://v3.fal.media/x.mp4' } }));
  try {
    assertEquals(await falAdapter.check(ref), { state: 'done', url: 'https://v3.fal.media/x.mp4', contentType: 'video/mp4' });
  } finally {
    restore();
  }
});

Deno.test('cancel PUTs the cancel endpoint only while queued', async () => {
  const ref = JSON.stringify({
    statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status',
    responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1',
  });
  const seen: string[] = [];
  let restore = stubFetch((url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return json({ status: 'IN_QUEUE' });
  });
  try {
    await falAdapter.cancel!(ref);
    assertEquals(seen[1], 'PUT https://queue.fal.run/fal-ai/kling-video/requests/r1/cancel');
  } finally {
    restore();
  }
  seen.length = 0;
  restore = stubFetch((url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return json({ status: 'IN_PROGRESS' });
  });
  try {
    await falAdapter.cancel!(ref);
    assertEquals(seen.length, 1);
  } finally {
    restore();
  }
});
