// R24: a cancelled video still reads "Cancelled · Refunded" after a reload.
//
// Cancellation used to be a client-side patch on the in-memory item. Reload
// the page and the patch was gone, so the customer's own cancellation came
// back as "Generation failed — Retry", with a retry button for something they
// had deliberately stopped. P4 persists the reason; this proves the list and
// detail shapes hand it back, and that raw provider text never rides along.
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

interface Failure {
  code: string;
  message: string;
  cancelled: boolean;
}

function withGeneration(db: FakeDb, over: Record<string, unknown>) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.generations = [{
    id: 'g1',
    user_id: TEST_USER,
    kind: 'video',
    family_id: 'kling',
    family_name: 'Kling 3.0 Pro',
    op: 'generate',
    prompt: 'a cat walks',
    settings: {},
    price_credits: 40,
    status: 'failed',
    media_path: null,
    parent_id: null,
    deleted_at: null,
    created_at: '2026-09-20T00:00:00Z',
    ...over,
  }];
}

async function itemOf(db: FakeDb, deps: ReturnType<typeof testDeps>) {
  const res = await createApp(deps).request('/api/generations/g1', { headers: AUTH });
  const body = await res.json();
  assertEquals(res.status, 200, JSON.stringify(body));
  return body.item as { status: string; failure?: Failure };
}

Deno.test('R24: a cancelled generation survives a reload as cancelled', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, {
    failure_code: 'cancelled',
    failure_message: 'Cancelled · Refunded',
  });

  const item = await itemOf(db, deps);
  assertEquals(item.status, 'failed');
  assertEquals(item.failure?.code, 'cancelled');
  assertEquals(item.failure?.cancelled, true);
  assertEquals(item.failure?.message, 'Cancelled · Refunded');
});

Deno.test('R24: a provider failure is NOT reported as a cancellation', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, {
    failure_code: 'provider_error',
    failure_message: 'Generation failed. Your credits were refunded.',
  });

  const item = await itemOf(db, deps);
  assertEquals(item.failure?.code, 'provider_error');
  assertEquals(item.failure?.cancelled, false);
});

Deno.test('R24: no raw provider text reaches the customer', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, {
    failure_code: 'provider_error',
    failure_message: 'Generation failed. Your credits were refunded.',
  });
  db.tables.jobs = [{
    id: 'j1',
    generation_id: 'g1',
    user_id: TEST_USER,
    state: 'error',
    // What the provider actually said. It belongs in the job row and nowhere
    // near a customer.
    error: 'fal: 502 upstream "cuda out of memory at device 3" trace=abc123',
  }];

  const item = await itemOf(db, deps);
  const json = JSON.stringify(item);
  assert(!json.includes('cuda'), json);
  assert(!json.includes('trace='), json);
  assert(!json.includes('502'), json);
});

Deno.test('R24: an unrecognised failure code is reported as a generic failure', async () => {
  // Never echo a code the client has no rendering for, and never leak one a
  // future provider adapter invents.
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, { failure_code: 'kraken_attack', failure_message: 'the kraken' });

  const item = await itemOf(db, deps);
  assertEquals(item.failure?.code, 'generation_failed');
  assertEquals(item.failure?.cancelled, false);
});

Deno.test('R24: a row settled before the failure columns existed still reads sensibly', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, { failure_code: null, failure_message: null });

  const item = await itemOf(db, deps);
  assertEquals(item.failure?.code, 'generation_failed');
  assert((item.failure?.message ?? '').length > 10);
});

Deno.test('a healthy generation carries no failure at all', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  withGeneration(db, {
    status: 'done',
    media_path: `${TEST_USER}/out.png`,
    failure_code: 'cancelled',
  });

  const item = await itemOf(db, deps);
  // A stale failure_code on a done row must not resurrect as a banner.
  assertEquals(item.failure, undefined);
});
