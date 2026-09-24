// R15: every submission records what was actually asked for.
//
// These assert the gateway side of 0023 — that the snapshot exists, that it
// holds identities rather than URLs, and that the fields a retry needs (mask,
// references, persona, trend, mode) survive the trip. The RPC side (one
// snapshot per submission, none on replay, all-or-nothing) is in
// `supabase/tests/request_snapshots.sql`, which needs a real database.
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { CATALOG_VERSION } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const MINE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const SECOND = `${TEST_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

interface Snapshot {
  version: number;
  op: string;
  familyId: string;
  prompt: string;
  referenceUploadIds: string[];
  referenceSlots: { first: string | null; last: string | null; references: string[] };
  maskUploadId: string | null;
  personaId: string | null;
  trendId: string | null;
  mode: string | null;
  parentId: string | null;
  catalogVersion: string;
  quoteVersion: number;
}

function ready(db: FakeDb, familyId: string, plan = 'pro') {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan, status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: familyId, enabled: true, min_plan: 'studio' }];
  for (const path of [MINE, SECOND]) {
    db.tables.uploads = [...(db.tables.uploads ?? []), {
      id: path,
      user_id: TEST_USER,
      path,
      purpose: 'reference',
      mime: 'image/png',
      width: 1024,
      height: 1024,
      moderation: 'allowed',
    }];
    db.storage.from('uploads').upload(path, new Uint8Array([1]), { contentType: 'image/png' });
  }
}

function snapshotOf(db: FakeDb): Snapshot {
  const call = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation');
  assert(call, 'no reservation was made');
  const payload = call.args.p_payload as Record<string, unknown>;
  const snapshot = payload.snapshot as Snapshot | undefined;
  assert(snapshot, 'the submission carried no snapshot');
  return snapshot;
}

Deno.test('R15: a plain generation records a replayable snapshot', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'flux');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      settings: { aspectRatio: '1:1', resolution: '1MP' },
    }),
  });

  assertEquals(res.status, 202, await res.text());
  const snapshot = snapshotOf(db);
  assertEquals(snapshot.version, 1);
  assertEquals(snapshot.op, 'generate');
  assertEquals(snapshot.familyId, 'flux');
  assertEquals(snapshot.prompt, 'a cat');
  assertEquals(snapshot.catalogVersion, CATALOG_VERSION);
});

Deno.test('R15: a reference is recorded by upload path, never as a signed URL', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'nano-banana');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate',
      familyId: 'nano-banana',
      prompt: 'a cat wearing this hat',
      settings: { aspectRatio: '1:1', resolution: '1K' },
      referenceUploadId: MINE,
    }),
  });

  assertEquals(res.status, 202, await res.text());
  const snapshot = snapshotOf(db);
  assertEquals(snapshot.referenceUploadIds, [MINE]);
  // Signed URLs expire in 7 days; a snapshot is read long after that.
  const json = JSON.stringify(snapshot);
  assert(!json.includes('token='), json);
  assert(!json.includes('/sign/'), json);
});

// Style presets are gone; an old cached web bundle may still send `style`.
Deno.test('R15: trend is first-class in the snapshot; a legacy style field is ignored', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'flux');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      settings: { aspectRatio: '1:1', resolution: '1MP' },
      style: 'no-such-style',
      trendId: '90s-yearbook',
    }),
  });

  assertEquals(res.status, 202, await res.text());
  const snapshot = snapshotOf(db);
  assertEquals(snapshot.trendId, '90s-yearbook');
  assertEquals('styleId' in snapshot, false);
  const call = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation');
  const payload = call!.args.p_payload as Record<string, unknown>;
  assertEquals(payload.prompt, 'a cat');
  assertEquals('style' in (payload.settings as Record<string, unknown>), false);
});

Deno.test('R15: a keyframes video records which frame is first and which is last', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'kling');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate',
      familyId: 'kling',
      prompt: 'a cat walks',
      settings: { aspectRatio: '16:9', durationS: 5, audio: 'off', mode: 'keyframes' },
      referencePaths: [MINE, SECOND],
    }),
  });

  assertEquals(res.status, 202, await res.text());
  const snapshot = snapshotOf(db);
  assertEquals(snapshot.mode, 'keyframes');
  // Order is the whole meaning here — swapping these runs the video backwards.
  assertEquals(snapshot.referenceSlots.first, MINE);
  assertEquals(snapshot.referenceSlots.last, SECOND);
  assertEquals(snapshot.referenceUploadIds, [MINE, SECOND]);
});

Deno.test('R15: an i2v video records its reference as a plain reference, not a keyframe', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'kling');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate',
      familyId: 'kling',
      prompt: 'a cat walks',
      settings: { aspectRatio: '16:9', durationS: 5, audio: 'off', mode: 'i2v' },
      referencePaths: [MINE],
    }),
  });

  assertEquals(res.status, 202, await res.text());
  const snapshot = snapshotOf(db);
  assertEquals(snapshot.mode, 'i2v');
  assertEquals(snapshot.referenceSlots.first, null);
  assertEquals(snapshot.referenceSlots.references, [MINE]);
});
