import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, fakeModeration, TEST_USER, testDeps } from './testing/fakes.ts';
import { EDIT_TOOLS } from './_shared/model-families.ts';

// Owner decision 2026-09-23 (migration 0034): the AI edit tools are Pro. The
// plan floor is the `models.min_plan` row, read by modelGate on submit, and a
// Studio caller is refused before moderation runs and before anything is charged.

const AUTH = { authorization: 'Bearer test-token' };
const PARENT = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const MASK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function seed(db: FakeDb, plan: 'studio' | 'pro') {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan, status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = EDIT_TOOLS.map((t) => ({ id: t.id, enabled: true, min_plan: 'pro' }));
  db.tables.generations = [{
    id: 'p1', user_id: TEST_USER, kind: 'image', family_id: 'flux', op: 'generate',
    prompt: 'a cat', settings: {}, price_credits: 40, status: 'done',
    media_path: PARENT, storage_backend: 'supabase', deleted_at: null,
  }];
  db.storage.from('media').upload(PARENT, new Uint8Array([1]), { contentType: 'image/png' });
  db.rpcHandlers.fn_reserve_generation = (args) => ({
    replay: false,
    items: (args.p_items as Record<string, unknown>[]).map((i, n) => ({
      id: `new${n}`, user_id: TEST_USER, family_id: i.familyId, op: i.op,
      prompt: i.prompt, settings: i.settings, status: 'pending', price_credits: 5,
      parent_id: i.parentId ?? null, media_path: null, kind: 'image',
      family_name: i.familyName,
    })),
    credits: { plan: 1000, pack: 0 },
  });
}

function editBody(toolId: string) {
  return JSON.stringify({
    op: 'edit',
    familyId: toolId,
    prompt: 'a red balloon',
    batch: 1,
    settings: { aspectRatio: '1:1' },
    parentId: 'p1',
    maskPngBase64: MASK_PNG,
  });
}

for (const tool of EDIT_TOOLS) {
  Deno.test(`${tool.id}: a Studio subscriber is refused pro_required, unmoderated and uncharged`, async () => {
    const provider = fakeAdapter();
    const moderation = fakeModeration();
    const deps = testDeps({ adapterFor: () => provider.adapter, moderate: moderation.moderate });
    const db = deps.admin as unknown as FakeDb;
    seed(db, 'studio');
    const app = createApp(deps);

    const res = await app.request('/api/generations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: editBody(tool.id),
    });

    assertEquals(res.status, 403);
    assertEquals((await res.json()).error.code, 'pro_required');
    assertEquals(moderation.calls.length, 0);
    assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_reserve_generation').length, 0);
    assertEquals(provider.submits.length, 0);
  });
}

Deno.test('edit-bg: a Pro subscriber passes the plan gate and is charged once', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter, moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  seed(db, 'pro');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: editBody('edit-bg'),
  });

  assertEquals(res.status, 202);
  assertEquals(moderation.calls.length > 0, true);
  const reserves = db.rpcCalls.filter((r) => r.name === 'fn_reserve_generation');
  assertEquals(reserves.length, 1);
  const item = (reserves[0].args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.familyId, 'edit-bg');
});
