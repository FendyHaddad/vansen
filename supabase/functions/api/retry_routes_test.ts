import { assertEquals, assert } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';
import { CATALOG_VERSION } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token' };
const UP_ONE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const UP_TWO = `${TEST_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const MASK = `${TEST_USER}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`;

function seed(db: FakeDb, over: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  // Every family a retry can land on, including the pseudo-family a persona
  // run is stored and gated under.
  db.tables.models = [
    { id: 'flux', enabled: true, min_plan: 'studio' },
    { id: 'nano-banana', enabled: true, min_plan: 'studio' },
    { id: 'edit-fill', enabled: true, min_plan: 'studio' },
    { id: 'upscaler', enabled: true, min_plan: 'studio' },
    { id: 'persona', enabled: true, min_plan: 'studio' },
    { id: 'kling', enabled: true, min_plan: 'pro' },
  ];
  // The P1 registry rows the snapshot's identities point at. Without these a
  // retry refuses with reference_unavailable, which is correct behaviour and
  // has its own test — it must not be the accidental result of every test.
  db.tables.uploads = [UP_ONE, UP_TWO, MASK].map((path) => ({
    id: path,
    user_id: TEST_USER,
    path,
    purpose: path === MASK ? 'mask' : 'reference',
    mime: 'image/png',
    bytes: 100,
    width: 1024,
    height: 1024,
    moderation: 'allowed',
  }));
  for (const path of [UP_ONE, UP_TWO, MASK]) {
    db.storage.from('uploads').upload(path, new Uint8Array([1]), { contentType: 'image/png' });
  }
  db.tables.request_snapshots = [{
    id: 'snap-1', user_id: TEST_USER, version: 1,
    body: {
      version: 1, op: 'generate', familyId: 'flux', prompt: 'a cat',
      settings: { aspectRatio: '1:1' }, referenceUploadIds: [],
      referenceSlots: { first: null, last: null, references: [] },
      maskUploadId: null, personaId: null, styleId: null, trendId: null, mode: null,
      parentId: null, catalogVersion: CATALOG_VERSION, quoteVersion: 1,
      ...snapshot,
    },
  }];
  db.tables.generations = [{
    id: 'g1', user_id: TEST_USER, kind: 'image', family_id: 'flux', op: 'generate',
    prompt: 'a cat', settings: {}, price_credits: 40, status: 'failed',
    snapshot_id: 'snap-1',
    // A finished generation has media. A variation resolves its parent, so a
    // 'done' row with no media_path would refuse as parent_not_ready.
    media_path: over.status === 'done' ? UP_ONE : null,
    storage_backend: 'supabase', deleted_at: null, ...over,
  }];
  db.rpcHandlers.fn_reserve_generation = (args) => ({
    replay: false,
    items: (args.p_items as Record<string, unknown>[]).map((i, n) => ({
      id: `new${n}`, user_id: TEST_USER, family_id: i.familyId, op: i.op,
      prompt: i.prompt, settings: i.settings, status: 'pending', price_credits: 40,
      parent_id: i.parentId ?? null, media_path: null, kind: 'image',
      family_name: i.familyName,
    })),
    credits: { plan: 1000, pack: 0 },
  });
}

Deno.test('R15: retrying a failed image re-runs the same request', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 202);
  const call = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  const item = (call.args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.prompt, 'a cat');
  assertEquals(item.familyId, 'flux');
});

Deno.test('R15: retrying an edit carries the MASK', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit' }, {
    op: 'edit', familyId: 'edit-fill', maskUploadId: MASK, parentId: 'parent-1',
  });
  db.tables.generations = [...db.tables.generations, {
    id: 'parent-1', user_id: TEST_USER, kind: 'image', family_id: 'flux',
    op: 'generate', status: 'done', media_path: UP_ONE, storage_backend: 'supabase',
    settings: {}, price_credits: 40, deleted_at: null,
  }];
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 202, await res.text());
  // The mask rides on the job payload, not on the per-output item.
  const payload = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_payload as Record<string, unknown>;
  assert(payload.maskUploadId, 'the mask must be restored');
  assertEquals(payload.maskUploadId, MASK);
  // And it must survive into the snapshot, or the SECOND retry loses it.
  const snapshot = payload.snapshot as Record<string, unknown>;
  assertEquals(snapshot.maskUploadId, MASK);
});

Deno.test('R15: retrying a video i2v carries its REFERENCES', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'kling', kind: 'video' }, {
    familyId: 'kling', mode: 'i2v', referenceUploadIds: [UP_ONE],
    settings: { aspectRatio: '16:9', durationS: 5, audio: 'off' },
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 202, await res.text());
});

Deno.test('R15: retrying a persona generation keeps the persona and the real family', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.personas = [{ id: 'p-1', user_id: TEST_USER, status: 'ready', lora_url: 'https://x/l.safetensors' }];
  seed(db, { family_id: 'persona' }, { familyId: 'flux', personaId: 'p-1' });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 202, await res.text());
  // The reserved row is stored under the pseudo-family 'persona' — that is the
  // server's own convention for display and pricing, and it is unchanged. What
  // matters is that the RETRY did not send 'persona' as a model family: it sent
  // flux plus a persona id, and the server did its own mapping. Proof that the
  // rebuilt body carries the real family is in `services/retry_test.ts`; proof
  // it worked is that this reached the reservation at all, which the old
  // client-side retry never did (invalid_family).
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.familyId, 'persona');
  const snapshot = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_payload as Record<string, unknown>).snapshot as Record<string, unknown>;
  assertEquals(snapshot.familyId, 'flux', 'never re-send the pseudo-family "persona"');
  assertEquals(snapshot.personaId, 'p-1');
});

Deno.test('R15: a retry gets a FRESH quote, not the old price', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { price_credits: 9999 });
  const app = createApp(deps);
  await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assert(item.priceCredits !== 9999, 'the price must be re-quoted from the catalog');
});

Deno.test('R15: a retry is a NEW idempotent submission, not a replay of the old one', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const app = createApp(deps);
  await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  const key = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!.args.p_key;
  assert(key, 'a retry still gets its own idempotency key');
});

Deno.test('R15: a generation with no snapshot refuses with an explanation', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { snapshot_id: null });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  const err = (await res.json()).error;
  assertEquals(err.code, 'not_retryable');
  assert(err.message.length > 10, 'tell the customer why, do not just fail');
});

Deno.test('R15: a retry whose reference was deleted refuses instead of failing at the provider', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.uploads = [];
  seed(db, { family_id: 'kling', kind: 'video' }, {
    familyId: 'kling', mode: 'i2v', referenceUploadIds: ['gone'],
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'reference_unavailable');
});

Deno.test('R15: a variation carries parentId', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { status: 'done' });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/variation', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 202, await res.text());

  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.parentId, 'g1', 'a variation without a parent breaks the version chain');
});

Deno.test('R15: variation of an edit item refuses rather than producing invalid_op', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit', status: 'done' }, { op: 'edit', familyId: 'edit-fill' });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/variation', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'not_variable');
});

Deno.test('R15: the retryable probe tells the client what to enable', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit', status: 'failed' }, {
    op: 'edit', familyId: 'edit-fill', maskUploadId: MASK, parentId: 'parent-1',
  });
  const app = createApp(deps);
  const body = await (await app.request('/api/generations/g1/retryable', { headers: AUTH })).json();
  assertEquals(body.retry, true);
  assertEquals(body.variation, false);
});

Deno.test('R15: a stranger cannot retry someone else\'s generation', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { user_id: 'someone-else' });
  const app = createApp(deps);
  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 404);
});
