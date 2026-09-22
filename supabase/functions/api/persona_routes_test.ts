// Persona routes: five saved photo slots, no training. See
// docs/superpowers/specs/2026-09-23-persona-references-design.md.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, OTHER_USER, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const PERSONA = 'pppppppp-0000-4000-8000-000000000001';
const OTHER_PERSONA = 'pppppppp-0000-4000-8000-000000000002';

function setup(plan = 'studio') {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan, status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  }];
  return { app: createApp(deps), db };
}

function emptyPhotos() {
  return {
    front: null, left_three_quarter: null, right_three_quarter: null,
    left_profile: null, right_profile: null,
  };
}

function personaRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: TEST_USER, name: 'Me', status: 'draft', photos: emptyPhotos(),
    consent_attested_at: '2026-09-23T00:00:00Z', created_at: '2026-09-23T00:00:00Z',
    deleted_at: null, ...over,
  };
}

function seedUpload(db: FakeDb, n: number, over: Record<string, unknown> = {}): string {
  const path = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}.jpg`;
  db.tables.uploads ??= [];
  db.tables.uploads.push({
    id: `u${n}`, user_id: TEST_USER, path, purpose: 'persona-photo',
    mime: 'image/jpeg', width: 1536, height: 2048, moderation: 'allowed', ...over,
  });
  return path;
}

/** A PNG header that reads as width×height, padded with zeros to `size` bytes. */
function pngForm(purpose: string, width: number, height: number, size: number): FormData {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: 'image/png' }), 'a.png');
  form.append('purpose', purpose);
  return form;
}

function tinyPngForm(purpose?: string): FormData {
  // Signature + enough IHDR for imageSize() to read 8×8 — well under the
  // 1024px persona floor.
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 8);
  view.setUint32(20, 8);
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: 'image/png' }), 'a.png');
  if (purpose) form.append('purpose', purpose);
  return form;
}

// ------------------------------------------------------------------- POST

Deno.test('POST /personas creates a draft through the locked reservation', async () => {
  const { app, db } = setup();
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: true }),
  });
  assertEquals(res.status, 200);
  assertEquals(db.rpcCalls.some((c) => c.name === 'fn_reserve_persona'), true);
  const body = await res.json();
  assertEquals(body.item.status, 'draft');
  assertEquals(body.item.photos.map((p: { slot: string }) => p.slot), [
    'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
  ]);
});

// Stripe marks a subscription `canceled` as soon as cancel-at-period-end is
// set; the customer has paid through the period and keeps the plan until then.
Deno.test('POST /personas works for a canceled plan still inside its paid period', async () => {
  const { app, db } = setup();
  db.tables.subscriptions[0].status = 'canceled';
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: true }),
  });
  assertEquals(res.status, 200);
});

Deno.test('the reservation refuses a canceled plan whose period has ended', async () => {
  const { db } = setup();
  db.tables.subscriptions[0].status = 'canceled';
  db.tables.subscriptions[0].current_period_end = '2020-01-01T00:00:00Z';
  const { error } = await db.rpc('fn_reserve_persona', {
    p_user: TEST_USER, p_key: crypto.randomUUID(), p_hash: 'h', p_name: 'Me',
  });
  assertEquals(error?.message?.includes('subscription_required'), true);
});

Deno.test('POST /personas without consent is refused', async () => {
  const { app } = setup();
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: false }),
  });
  assertEquals(res.status, 400);
});

Deno.test('POST /personas at the plan limit is refused with slot_limit', async () => {
  const { app, db } = setup('studio'); // studio = 2 slots
  db.tables.personas = [
    personaRow('p1', { status: 'draft' }),
    personaRow('p2', { status: 'ready' }),
  ];
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'One too many', attested: true }),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'slot_limit');
});

Deno.test('a deleted persona does not count against the slot limit', async () => {
  const { app, db } = setup('studio');
  db.tables.personas = [
    personaRow('p1', { status: 'draft', deleted_at: '2026-09-23T00:00:00Z' }),
    personaRow('p2', { status: 'ready' }),
  ];
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Room for one more', attested: true }),
  });
  assertEquals(res.status, 200);
});

Deno.test('POST /personas replays the same idempotency key instead of creating twice', async () => {
  const { app, db } = setup();
  const headers = { ...JSON_AUTH, 'Idempotency-Key': 'b3b1f2a0-0000-4000-8000-000000000098' };
  const body = JSON.stringify({ name: 'Me', attested: true });
  const first = await app.request('/api/personas', { method: 'POST', headers, body });
  const second = await app.request('/api/personas', { method: 'POST', headers, body });
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals((await first.json()).item.id, (await second.json()).item.id);
  assertEquals((db.tables.personas ?? []).length, 1);
});

Deno.test('POST /personas with the same key and a different body is a conflict, not a replay', async () => {
  const { app } = setup();
  const headers = { ...JSON_AUTH, 'Idempotency-Key': 'b3b1f2a0-0000-4000-8000-000000000099' };
  await app.request('/api/personas', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Me', attested: true }),
  });
  const res = await app.request('/api/personas', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Someone else', attested: true }),
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'idempotency_conflict');
});

Deno.test('a replayed key whose persona was since deleted is a 404, not a crash', async () => {
  const { app, db } = setup();
  const headers = { ...JSON_AUTH, 'Idempotency-Key': 'b3b1f2a0-0000-4000-8000-000000000097' };
  const body = JSON.stringify({ name: 'Me', attested: true });
  const first = await app.request('/api/personas', { method: 'POST', headers, body });
  const personaId = (await first.json()).item.id;
  db.tables.personas = (db.tables.personas ?? []).filter((p) => p.id !== personaId);

  const second = await app.request('/api/personas', { method: 'POST', headers, body });
  assertEquals(second.status, 404);
});

Deno.test('a failed client-tag update is logged, not ignored, and does not fail the create', async () => {
  const { app, db } = setup();
  db.failNext('personas.update', 'db unavailable');
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: true }),
  });
  assertEquals(res.status, 200);
  assertEquals(
    (db.tables.app_errors ?? []).some((e) => e.code === 'persona_client_update_failed'),
    true,
  );
});

// -------------------------------------------------------------------- GET

Deno.test('GET /personas returns the DTO shape and slot usage', async () => {
  const { app, db } = setup('pro'); // pro = 5 slots
  db.tables.personas = [personaRow(PERSONA)];
  const res = await app.request('/api/personas', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.slots, { used: 1, max: 5 });
  assertEquals(body.items[0].id, PERSONA);
  assertEquals(body.items[0].status, 'draft');
  assertEquals(body.items[0].photos.length, 5);
  assertEquals(typeof body.items[0].thumbUrl, 'string');
  assertEquals(typeof body.items[0].createdAt, 'string');
});

// -------------------------------------------------------------------- PUT

Deno.test('PUT a slot stores the photo and reports draft, not ready, with slots left', async () => {
  const { app, db } = setup();
  db.tables.personas = [personaRow(PERSONA)];
  const path = seedUpload(db, 1);
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.status, 'draft');
  assertEquals(body.item.photos[0].slot, 'front');
  assertEquals(typeof body.item.photos[0].url, 'string');
});

Deno.test('PUT filling all five slots reports the persona ready', async () => {
  const { app, db } = setup();
  db.tables.personas = [personaRow(PERSONA)];
  const slots = ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile'];
  let last: Response | undefined;
  for (let i = 0; i < slots.length; i++) {
    const path = seedUpload(db, 20 + i);
    last = await app.request(`/api/personas/${PERSONA}/photos/${slots[i]}`, {
      method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
    });
  }
  assertEquals(last!.status, 200);
  assertEquals((await last!.json()).item.status, 'ready');
});

Deno.test('PUT an unknown slot is a 400', async () => {
  const { app } = setup();
  const res = await app.request(`/api/personas/${PERSONA}/photos/back`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: 'x' }),
  });
  assertEquals(res.status, 400);
});

Deno.test('PUT a photo under 1024px on its short edge is refused', async () => {
  const { app, db } = setup();
  db.tables.personas = [personaRow(PERSONA)];
  const path = seedUpload(db, 2, { width: 900, height: 1600 });
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'photo_too_small');
});

Deno.test('PUT a photo already held by another of the user\'s personas is refused with photo_unavailable', async () => {
  const { app, db } = setup();
  const path = seedUpload(db, 3);
  db.tables.personas = [
    personaRow(PERSONA),
    personaRow(OTHER_PERSONA, { photos: { ...emptyPhotos(), front: path } }),
  ];
  const res = await app.request(`/api/personas/${PERSONA}/photos/left_profile`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'photo_unavailable');
});

Deno.test('PUT replacing a slot photo queues the old photo for deletion', async () => {
  const { app, db } = setup();
  const oldPath = seedUpload(db, 4);
  const newPath = seedUpload(db, 5);
  db.tables.personas = [personaRow(PERSONA, { photos: { ...emptyPhotos(), front: oldPath } })];
  db.tables.storage_objects ??= [];
  db.tables.storage_objects.push({
    id: 'obj-old-front', user_id: TEST_USER, backend: 'supabase', bucket: 'uploads',
    path: oldPath, purpose: 'persona-photo', state: 'live', retain_until: null,
  });

  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: newPath }),
  });

  assertEquals(res.status, 200);
  assertEquals(
    (db.tables.deletion_outbox ?? []).some((d) => d.object_id === 'obj-old-front'),
    true,
  );
});

Deno.test('PUT on another user\'s persona is a 404', async () => {
  const { app, db } = setup();
  db.tables.personas = [personaRow(PERSONA, { user_id: OTHER_USER })];
  const path = seedUpload(db, 6);
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 404);
});

Deno.test('the training route is gone', async () => {
  const { app } = setup();
  const res = await app.request(`/api/personas/${PERSONA}/train`, {
    method: 'POST', headers: JSON_AUTH, body: '{}',
  });
  assertEquals(res.status, 404);
});

// ----------------------------------------------------------------- upload

Deno.test('uploading a persona photo under 1024px is refused with photo_too_small', async () => {
  const { app } = setup();
  const res = await app.request('/api/uploads', {
    method: 'POST', headers: AUTH, body: tinyPngForm('persona-photo'),
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'photo_too_small');
});

const PHOTO_MAX_BYTES = 2.5 * 1024 * 1024;

Deno.test('uploading a persona photo over 2.5 MB is refused with photo_too_large', async () => {
  const { app } = setup();
  const res = await app.request('/api/uploads', {
    method: 'POST', headers: AUTH, body: pngForm('persona-photo', 1536, 2048, PHOTO_MAX_BYTES + 1),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.code, 'photo_too_large');
  assertEquals(body.error.message, 'Use a smaller photo — at most 2.5 MB.');
});

Deno.test('a persona photo of exactly 2.5 MB, and a reference over 2.5 MB, are not refused as too large', async () => {
  const { app } = setup();
  for (const form of [
    pngForm('persona-photo', 1536, 2048, PHOTO_MAX_BYTES),
    pngForm('reference', 1536, 2048, PHOTO_MAX_BYTES + 1),
  ]) {
    const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: form });
    const code = res.status === 200 ? null : (await res.json()).error?.code;
    assertEquals(code === 'photo_too_large', false);
  }
});

// ----------------------------------------------------------- PUT, row gone

Deno.test('PUT whose persona is gone by the time it is re-read is a 404, not a crash', async () => {
  const { app, db } = setup();
  db.tables.personas = [personaRow(PERSONA)];
  const path = seedUpload(db, 7);
  const setPhoto = db.rpcHandlers.fn_set_persona_photo;
  db.rpcHandlers.fn_set_persona_photo = (args, self) => {
    const out = setPhoto(args, self);
    self.tables.personas = [];
    return out;
  };
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, 'not_found');
});
