import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, fakeModeration, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function pngBytes(): Uint8Array {
  // Signature + enough IHDR for imageSize() to read 8×8 — POST /uploads reads
  // the dimensions before it will store anything.
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 8);
  view.setUint32(20, 8);
  return bytes;
}

function uploadForm(): FormData {
  const form = new FormData();
  form.append('file', new Blob([pngBytes() as BlobPart], { type: 'image/png' }), 'a.png');
  return form;
}

function subscribed(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
}

Deno.test('upload: moderation unavailable → 503, nothing stored, no strike', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'unavailable', reason: 'moderation_http_503', retryAfterSeconds: 30 });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(res.headers.get('retry-after'), '30');
  assertEquals(db.storage.objects.size, 0);
  assertEquals(db.tables.moderation_events ?? [], []);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 0);
});

Deno.test('upload: signing failure blocks the upload instead of skipping the check', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.storage.failNext('uploads.createSignedUrl', 'signer down');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(moderation.calls.length, 0);
  assertEquals(db.storage.objects.size, 0);
});

Deno.test('upload: storage write failure never reaches moderation', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.storage.failNext('uploads.upload', 'disk full');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 400);
  assertEquals(moderation.calls.length, 0);
});

Deno.test('upload: flagged image is quarantined once and striked once', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { violence: 0.9 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 422);
  assertEquals((await res.json()).error.code, 'content_policy');
  assertEquals(db.tables.moderation_events.length, 1);
  const quarantined = [...db.storage.objects.keys()].filter((k) => k.includes('quarantine/'));
  assertEquals(quarantined.length, 1);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 1);
});

Deno.test('upload: quarantine copy failure still refuses and does not record phantom evidence', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { violence: 0.9 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  db.storage.failNext('uploads.copy', 'copy failed');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals(db.tables.moderation_events.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 0);
});

Deno.test('generate: prompt moderation unavailable → 503 with no charge and no provider call', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'unavailable', reason: 'moderation_unreachable', retryAfterSeconds: 10 });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  subscribed(db);
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '1MP' },
    }),
  });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});

Deno.test('thumb: poster is moderated before it is stored', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { sexual: 0.8 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  db.tables.generations = [
    { id: 'v1', user_id: TEST_USER, kind: 'video', status: 'done', storage_backend: 'r2', thumb_path: null },
  ];
  const app = createApp(deps);

  const form = new FormData();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  form.append('file', new Blob([jpeg as BlobPart], { type: 'image/jpeg' }), 'p.jpg');
  const res = await app.request('/api/generations/v1/thumb', { method: 'POST', headers: AUTH, body: form });

  assertEquals(res.status, 422);
  assertEquals(db.tables.generations[0].thumb_path, null);
});

Deno.test('moderation outage persists an alert before replying without charging', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'unavailable', reason: 'moderation_http_503', retryAfterSeconds: 30 });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  const res = await createApp(deps).request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });
  assertEquals(res.status, 503);
  assertEquals(db.rpcCalls.filter(c => c.name === 'fn_raise_alert').map(c => c.args.p_kind), ['moderation_unavailable']);
});
