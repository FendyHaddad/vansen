import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { MODEL_FAMILIES } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token' };
const MINE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

function ready(db: FakeDb, familyId: string) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: familyId, enabled: true, min_plan: 'studio' }];
  db.tables.uploads = [
    {
      id: 'u1',
      user_id: TEST_USER,
      path: MINE,
      purpose: 'reference',
      mime: 'image/png',
      width: 1024,
      height: 1024,
      moderation: 'allowed',
    },
  ];
  db.storage.from('uploads').upload(MINE, new Uint8Array([1]), { contentType: 'image/png' });
  db.rpcHandlers.fn_charge_and_generate = (args) => {
    const items = args.p_items as Record<string, unknown>[];
    return items.map((item, i) => ({
      id: `g${i}`,
      user_id: TEST_USER,
      kind: item.kind,
      family_id: item.familyId,
      family_name: item.familyName,
      op: item.op,
      prompt: item.prompt,
      settings: item.settings,
      price_credits: item.priceCredits,
      status: 'pending',
      media_path: null,
    }));
  };
}

// Driven from the catalog, not a literal list: FLUX dropped its reference
// claim in P3 (fal-ai/flux-2 has no reference input), and a family that stops
// accepting references must drop out of this loop rather than fail it.
const REFERENCE_FAMILIES = MODEL_FAMILIES
  .filter((f) => f.kind === 'image' && f.capabilities.imageInput)
  .map((f) => f.id);

for (const familyId of REFERENCE_FAMILIES) {
  Deno.test(`${familyId}: an uploaded reference charges once and reaches the adapter`, async () => {
    const provider = fakeAdapter();
    const deps = testDeps({ adapterFor: () => provider.adapter });
    const db = deps.admin as unknown as FakeDb;
    ready(db, familyId);
    const app = createApp(deps);

    const res = await app.request('/api/generations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'generate',
        familyId,
        prompt: 'a cat wearing this hat',
        batch: 1,
        settings: {
          aspectRatio: '1:1',
          resolution: familyId === 'flux' ? '1MP' : '1K',
          version: familyId === 'gpt-image' ? '2' : undefined,
          quality: familyId === 'gpt-image' ? 'medium' : undefined,
        },
        referenceUploadId: MINE,
      }),
    });

    assertEquals(res.status, 200);
    assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 1);
    assertEquals(provider.submits.length, 1);
    assertEquals(provider.submits[0].op, 'generate');
    assertEquals(typeof provider.submits[0].referenceUrl, 'string');
    assertEquals(provider.submits[0].referenceUrl?.includes(MINE), true);
  });
}

Deno.test('a reference is refused for a family that takes no image input', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'veo');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'veo',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '16:9', mode: 't2v', durationS: 4, resolution: '1080p' },
      referenceUploadId: MINE,
    }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'reference_unsupported');
  assertEquals(provider.submits.length, 0);
});

Deno.test('edit without a parent is still rejected', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'edit-bg');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'edit',
      familyId: 'edit-bg',
      prompt: 'x',
      batch: 1,
      settings: { aspectRatio: '1:1' },
    }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'invalid_parent');
});
