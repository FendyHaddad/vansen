// The gateway's half of durable dispatch: reserve, answer, and stop.
//
// Every test here is about something the routes must NOT do any more — call a
// provider, wait for one, or charge twice for a retried request.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const KEY = 'b3b1f2a0-0000-4000-8000-000000000001';

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.notification_outbox = [];
}

function generate(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    op: 'generate',
    familyId: 'flux',
    prompt: 'a cat',
    batch: 1,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
    ...over,
  });
}

function post(body: string, idempotencyKey?: string) {
  const headers: Record<string, string> = { ...AUTH, 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return { method: 'POST', headers, body };
}

Deno.test('POST /generations answers 202 and calls no provider', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', post(generate()));

  assertEquals(res.status, 202);
  assertEquals(provider.submits.length, 0);
  assertEquals(provider.checks.length, 0);
});

Deno.test('the accepted response carries the persisted rows and a runnable job', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', post(generate()));
  const items = (await res.json()).items as Record<string, unknown>[];

  assertEquals(items.length, 1);
  assertEquals(items[0].status, 'pending');
  const stored = db.tables.generations.find((g) => g.id === items[0].id);
  assertEquals(stored !== undefined, true, 'the id in the response must exist in the database');
  // The work is queued, not started: nothing has a provider reference yet.
  assertEquals(db.tables.jobs.length, 1);
  assertEquals(db.tables.jobs[0].state, 'ready');
  assertEquals(db.tables.jobs[0].provider_ref, null);
});

Deno.test('a replay of the same key returns the same ids and reserves once', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const first = await app.request('/api/generations', post(generate(), KEY));
  const second = await app.request('/api/generations', post(generate(), KEY));

  assertEquals(first.status, 202);
  assertEquals(second.status, 202);
  const a = (await first.json()).items.map((i: { id: string }) => i.id);
  const b = (await second.json()).items.map((i: { id: string }) => i.id);
  assertEquals(a, b);
  // One generation, not two: the retry cost the customer nothing.
  assertEquals(db.tables.generations.length, 1);
});

Deno.test('a replay after the user deleted the item answers 202 without the tombstoned row', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  await app.request('/api/generations', post(generate(), KEY));
  db.tables.generations[0].deleted_at = '2026-09-20T00:00:01.000Z';
  const again = await app.request('/api/generations', post(generate(), KEY));

  assertEquals(again.status, 202);
  assertEquals((await again.json()).items, []);
  assertEquals(db.tables.generations.length, 1);
});

Deno.test('the same key with a DIFFERENT body is refused, not silently replayed', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  await app.request('/api/generations', post(generate(), KEY));
  const res = await app.request('/api/generations', post(generate({ prompt: 'a dog' }), KEY));

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'idempotency_conflict');
  assertEquals(db.tables.generations.length, 1);
});

Deno.test('a client that sends no key still gets a replay record', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  await app.request('/api/generations', post(generate()));

  assertEquals((db.tables.submissions ?? []).length, 1);
  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation');
  assertEquals(typeof reserve?.args.p_key, 'string');
  assertEquals(typeof reserve?.args.p_hash, 'string');
});

Deno.test('a reservation that rolls back leaves no generation and no job', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  // What the real transaction does when the job insert violates
  // one_generation_job: everything it wrote goes with it.
  db.rpcHandlers.fn_reserve_generation = () => {
    throw new Error('duplicate key value violates unique constraint "one_generation_job"');
  };
  const app = createApp(deps);

  const res = await app.request('/api/generations', post(generate()));

  assertEquals(res.status, 400);
  assertEquals(db.tables.generations.length, 0);
  assertEquals(db.tables.jobs.length, 0);
  assertEquals(provider.submits.length, 0);
});

Deno.test('GET /jobs calls zero provider APIs', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  await app.request('/api/generations', post(generate()));

  const res = await app.request('/api/jobs?ids=g0', { headers: AUTH });

  assertEquals(res.status, 200);
  assertEquals(provider.checks.length, 0);
  assertEquals(provider.submits.length, 0);
});

Deno.test('cancel is a durable request, not a provider call', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  await app.request('/api/generations', post(generate()));
  db.tables.jobs[0].state = 'submitted';
  db.tables.jobs[0].provider_ref = 'req_1';

  const res = await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 202);
  const answer = await res.json();
  assertEquals(answer.cancelling, true);
  // No refund is promised here: only a provider that confirms it stopped earns one.
  assertEquals(answer.refundedCredits, 0);
  assertEquals(provider.cancels.length, 0);
  assertEquals(db.tables.jobs[0].cancel_requested_at !== null, true);
});
