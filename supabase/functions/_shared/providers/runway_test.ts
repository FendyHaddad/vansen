import { assertEquals } from 'jsr:@std/assert';
import { runwayAdapter, runwayRatio } from './runway.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('RUNWAY_API_KEY', 'rw-test');

Deno.test('runwayRatio maps aspect + resolution', () => {
  assertEquals(runwayRatio('16:9', '720p'), '1280:720');
  assertEquals(runwayRatio('16:9', '1080p'), '1920:1080');
  assertEquals(runwayRatio('9:16', '1080p'), '1080:1920');
  assertEquals(runwayRatio('1:1', '720p'), '960:960');
  assertEquals(runwayRatio('1:1', '1080p'), '1080:1080');
});

Deno.test('submit picks text_to_video or image_to_video by mode', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, init: init! });
    return json({ id: 'task_1' });
  });
  try {
    const r = await runwayAdapter.submit({
      familyId: 'runway', op: 'generate', prompt: 'drone shot', safetyId: 's',
      settings: { aspectRatio: '16:9', resolution: '1080p', durationS: 10 }, mode: 't2v',
    });
    assertEquals(r.providerRef, 'task_1');
    assertEquals(calls[0].url, 'https://api.dev.runwayml.com/v1/text_to_video');
    const h = calls[0].init.headers as Record<string, string>;
    assertEquals(h['X-Runway-Version'], '2024-11-06');
    assertEquals(h.Authorization, 'Bearer rw-test');
    assertEquals(JSON.parse(String(calls[0].init.body)), {
      model: 'gen4.5', promptText: 'drone shot', ratio: '1920:1080', duration: 10,
    });

    await runwayAdapter.submit({
      familyId: 'runway', op: 'generate', prompt: 'animate', safetyId: 's',
      settings: { aspectRatio: '9:16', resolution: '720p', durationS: 5 }, mode: 'i2v',
      referenceUrls: ['https://signed/ref.png'],
    });
    assertEquals(calls[1].url, 'https://api.dev.runwayml.com/v1/image_to_video');
    assertEquals(JSON.parse(String(calls[1].init.body)).promptImage, 'https://signed/ref.png');
  } finally {
    restore();
  }
});

Deno.test('check maps task states and progress', async () => {
  let restore = stubFetch(() => json({ id: 'task_1', status: 'PENDING' }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'running', phase: 'queued' });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'RUNNING', progress: 0.42 }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'running', phase: 'rendering', progress: 0.42 });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'SUCCEEDED', output: ['https://cdn/out.mp4'] }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'done', url: 'https://cdn/out.mp4', contentType: 'video/mp4' });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', failure: 'moderation' }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});

Deno.test('cancel issues DELETE /v1/tasks/:id', async () => {
  let seen = '';
  const restore = stubFetch((url, init) => {
    seen = `${init?.method} ${url}`;
    return new Response(null, { status: 204 });
  });
  try {
    await runwayAdapter.cancel!('task_1');
    assertEquals(seen, 'DELETE https://api.dev.runwayml.com/v1/tasks/task_1');
  } finally {
    restore();
  }
});
