import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, fakeModeration, TEST_USER, testDeps } from './testing/fakes.ts';
import { runWorkerTick } from './_shared/testing/worker.ts';
import { personaGenCreditCost, personaProviderCost } from './_shared/model-families.ts';
import { googleAdapter } from './_shared/providers/google.ts';
import { captureFetch } from './_shared/providers/testing/capture.ts';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const PERSONA = 'pppppppp-0000-4000-8000-000000000001';
const SLOTS = ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile'];

async function seed(db: FakeDb, status = 'ready') {
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan: 'studio', status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  }];
  db.tables.models = [
    { id: 'persona', enabled: true, min_plan: 'studio' },
    { id: 'nano-banana', enabled: true, min_plan: 'studio' },
  ];
  const photos: Record<string, string> = {};
  db.tables.uploads = [];
  for (let i = 0; i < SLOTS.length; i++) {
    const path = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}.jpg`;
    photos[SLOTS[i]] = path;
    db.tables.uploads.push({
      id: `u${i}`, user_id: TEST_USER, path, purpose: 'persona-photo',
      mime: 'image/jpeg', width: 1536, height: 2048, moderation: 'allowed',
    });
    await db.storage.from('uploads').upload(path, new Uint8Array([1]), { contentType: 'image/jpeg' });
  }
  db.tables.personas = [{
    id: PERSONA, user_id: TEST_USER, name: 'Me', status, photos,
    consent_attested_at: '2026-09-23T00:00:00Z', created_at: '2026-09-23T00:00:00Z', deleted_at: null,
  }];
}

async function submit(deps: ReturnType<typeof testDeps>, batch = 1) {
  const app = createApp(deps);
  return await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate', familyId: 'nano-banana', personaId: PERSONA, prompt: 'on a beach',
      batch, settings: { aspectRatio: '3:4', version: 'fast', resolution: '1K' },
    }),
  });
}

Deno.test('a persona generation is Nano Banana Pro 4K with five labelled photos', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await seed(db);

  const res = await submit(deps);
  assertEquals(res.status, 202, await res.clone().text());

  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  const item = (reserve.args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.familyId, 'persona');
  assertEquals(item.priceCredits, personaGenCreditCost());
  assertEquals(item.prompt, 'on a beach', 'the stored prompt is the customer\'s own');
  const quote = reserve.args.p_quote as Record<string, unknown>;
  assertEquals(quote.unitProviderCostUsd, personaProviderCost());

  await runWorkerTick(db, { adapterFor: () => provider.adapter });
  const sent = provider.submits[0];
  assertEquals(sent.familyId, 'persona', 'adapterFor(persona) is what runs it');
  assertEquals(sent.normalized!.providerModel, 'gemini-3-pro-image');
  assertEquals(sent.normalized!.providerSettings.image_size, '4K');
  assertEquals(sent.normalized!.providerSettings.aspect_ratio, '3:4');
  assertEquals(sent.personaPhotos!.map((p) => p.slot), SLOTS);
  assertStringIncludes(sent.prompt, 'Images 1–5 are the same person');
  assertStringIncludes(sent.prompt, 'on a beach');
});

Deno.test('a batch of four is four persona charges', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  const res = await submit(deps, 4);
  assertEquals(res.status, 202, await res.clone().text());
  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  const items = reserve.args.p_items as Record<string, unknown>[];
  assertEquals(items.length, 4);
  assertEquals(items.every((i) => i.priceCredits === personaGenCreditCost()), true);
});

Deno.test('a draft persona is refused as persona_unavailable', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db, 'draft');
  const res = await submit(deps);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'persona_unavailable');
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});

Deno.test('a deleted persona is refused as persona_unavailable', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  db.tables.personas[0].deleted_at = '2026-09-23T01:00:00Z';
  const res = await submit(deps);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'persona_unavailable');
});

Deno.test('the persona kill switch refuses persona runs only', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  db.tables.models = [
    { id: 'persona', enabled: false, min_plan: 'studio' },
    { id: 'nano-banana', enabled: true, min_plan: 'studio' },
  ];
  const res = await submit(deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'model_disabled');
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);

  // Nano Banana itself is untouched by the persona switch.
  const plain = await createApp(deps).request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate', familyId: 'nano-banana', prompt: 'on a beach', batch: 1,
      settings: { aspectRatio: '3:4', version: 'fast', resolution: '1K' },
    }),
  });
  assertEquals(plain.status, 202, await plain.clone().text());
});

Deno.test('moderation checks the customer\'s prompt, not our wrapper, before any charge', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  moderation.next({ state: 'blocked', categories: { violence: 0.99 } });
  const res = await submit(deps);
  assertEquals(res.status, 422);
  assertEquals((await res.json()).error.code, 'content_policy');
  assertEquals(moderation.calls[0].text, 'on a beach');
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});

Deno.test('a persona is generate-only and takes only ratios Nano Banana renders', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  const app = createApp(deps);
  const edit = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'edit', familyId: 'nano-banana', personaId: PERSONA, prompt: 'on a beach',
      parentId: 'g-parent', batch: 1, settings: { aspectRatio: '3:4' },
    }),
  });
  assertEquals(edit.status, 400);
  assertEquals((await edit.json()).error.code, 'invalid_op');

  const odd = await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate', familyId: 'nano-banana', personaId: PERSONA, prompt: 'on a beach',
      batch: 1, settings: { aspectRatio: '7:3' },
    }),
  });
  assertEquals(odd.status, 400);
  assertEquals((await odd.json()).error.code, 'invalid_settings');
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});

/**
 * fn_settle_job as 0020 writes it, reduced to what these tests read: one
 * settlement per job, and a failed one refunds exactly once.
 */
function installSettlement(db: FakeDb) {
  db.rpcHandlers.fn_settle_job = (args, self) => {
    const job = (self.tables.jobs ?? []).find((j) => j.id === args.p_job);
    const gen = (self.tables.generations ?? []).find((g) => g.id === job?.generation_id);
    if (!job || !gen || gen.status !== 'pending') {
      return { settled: false, previous: gen?.status ?? null, refunded: 0 };
    }
    job.state = 'done';
    gen.status = args.p_outcome === 'done' ? 'done' : 'failed';
    if (args.p_outcome === 'done') return { settled: true, previous: 'pending', refunded: 0 };
    self.tables.ledger_entries.push({
      user_id: gen.user_id, type: 'refund', generation_id: gen.id, credits: gen.price_credits,
    });
    return { settled: true, previous: 'pending', refunded: gen.price_credits };
  };
}

const refunds = (db: FakeDb) => db.tables.ledger_entries.filter((l) => l.type === 'refund');

Deno.test('an unreadable persona photo at dispatch fails the run and refunds once', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  installSettlement(db);
  assertEquals((await submit(deps)).status, 202);

  // Storage signs the photo, but the fetch of it fails: nothing was sent.
  const cap = captureFetch((call) =>
    call.url.includes('generativelanguage')
      ? Response.json({ candidates: [] })
      : new Response('gone', { status: 404 })
  );
  try {
    await runWorkerTick(db, { adapterFor: () => googleAdapter });
    await runWorkerTick(db, { adapterFor: () => googleAdapter });
  } finally {
    cap.restore();
  }

  assertEquals(cap.calls.some((c) => c.url.includes('generativelanguage')), false);
  assertEquals(db.tables.generations[0].status, 'failed');
  assertEquals(db.tables.jobs[0].state === 'reconciling', false, 'never held for reconciliation');
  assertEquals(refunds(db).length, 1);
});

Deno.test('a Google answer with no image fails the run and refunds once', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  installSettlement(db);
  assertEquals((await submit(deps)).status, 202);

  // The photos are readable and Google answers, but with no image part.
  const cap = captureFetch((call) =>
    call.url.includes('generativelanguage')
      ? Response.json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] })
      : new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200, headers: { 'content-type': 'image/jpeg' },
      })
  );
  try {
    await runWorkerTick(db, { adapterFor: () => googleAdapter });
    await runWorkerTick(db, { adapterFor: () => googleAdapter });
    await runWorkerTick(db, { adapterFor: () => googleAdapter });
  } finally {
    cap.restore();
  }

  assertEquals(cap.calls.some((c) => c.url.includes('generativelanguage')), true);
  assertEquals(db.tables.generations[0].status, 'failed');
  assertEquals(db.tables.jobs[0].state === 'reconciling', false, 'never held for reconciliation');
  assertEquals(refunds(db).length, 1);
});

Deno.test('a persona deleted before dispatch fails the run and refunds once', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  installSettlement(db);
  assertEquals((await submit(deps)).status, 202);
  db.tables.personas[0].deleted_at = '2026-09-23T01:00:00Z';

  await runWorkerTick(db, { adapterFor: () => provider.adapter });
  await runWorkerTick(db, { adapterFor: () => provider.adapter });

  assertEquals(provider.submits.length, 0);
  assertEquals(db.tables.generations[0].status, 'failed');
  assertEquals(refunds(db).length, 1);
});

Deno.test('a persona takes no other reference image', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  const app = createApp(deps);
  for (const extra of [{ parentId: 'g-parent' }, { referenceUploadId: db.tables.uploads[0].path }]) {
    const res = await app.request('/api/generations', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        op: 'generate', familyId: 'nano-banana', personaId: PERSONA, prompt: 'on a beach',
        batch: 1, settings: { aspectRatio: '3:4' }, ...extra,
      }),
    });
    assertEquals(res.status, 400, JSON.stringify(extra));
    assertEquals((await res.json()).error.code, 'invalid_reference');
  }
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});

Deno.test('the snapshot records the render family whose settings it stores', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  // A client naming some other family with a persona still renders Nano Banana.
  const res = await createApp(deps).request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate', familyId: 'flux', personaId: PERSONA, prompt: 'on a beach',
      batch: 1, settings: { aspectRatio: '3:4' },
    }),
  });
  assertEquals(res.status, 202, await res.clone().text());
  const payload = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_payload as Record<string, unknown>;
  const snapshot = payload.snapshot as Record<string, unknown>;
  assertEquals(snapshot.familyId, 'nano-banana');
  assertEquals(snapshot.personaId, PERSONA);
});

Deno.test('a persona lookup that errors is a 503, not persona_unavailable', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  db.failNext('personas.select', 'connection reset');
  const res = await submit(deps);
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, 'persona_lookup_failed');
  assertEquals(typeof body.error.errorId, 'string');
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});
