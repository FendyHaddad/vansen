import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, OTHER_USER, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const THEIRS = `${OTHER_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [
    // Seedream, not FLUX: P3 removed FLUX's reference input, so a FLUX request
    // with a reference is refused by the capability check before it ever
    // reaches the ownership guard these tests exist to prove.
    { id: 'seedream', enabled: true, min_plan: 'studio' },
    { id: 'edit-bg', enabled: true, min_plan: 'studio' },
  ];
  db.tables.uploads = [
    {
      id: 'u-theirs',
      user_id: OTHER_USER,
      path: THEIRS,
      purpose: 'reference',
      mime: 'image/png',
      width: 8,
      height: 8,
      moderation: 'allowed',
    },
  ];
  db.rpcHandlers.fn_charge_and_generate = () => {
    throw new Error('charge must not be reached');
  };
}

Deno.test('a foreign upload cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'seedream',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '1K' },
      referenceUploadId: THEIRS,
    }),
  });

  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'invalid_reference');
  assertEquals(provider.submits.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});

Deno.test('a quarantine path cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'seedream',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '1K' },
      referenceUploadId: `quarantine/${TEST_USER}/x.png`,
    }),
  });

  assertEquals(res.status, 403);
  assertEquals(provider.submits.length, 0);
});

Deno.test('a pending parent cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    {
      id: 'p1',
      user_id: TEST_USER,
      kind: 'image',
      status: 'pending',
      media_path: null,
      settings: {},
      price_credits: 0,
    },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'edit',
      familyId: 'edit-bg',
      prompt: 'cut out',
      batch: 1,
      settings: { aspectRatio: '1:1' },
      parentId: 'p1',
    }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'parent_not_ready');
  assertEquals(provider.submits.length, 0);
});
