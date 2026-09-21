import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import type { ApiDeps } from './app.ts';

const AUTH = { authorization: 'Bearer test-token' };

interface Applied {
  p_txn_id: string;
  p_credits: number;
  p_source: string;
  p_kind: string;
}

/** A gateway whose Stripe answers with exactly these checkout sessions. */
function wired(sessions: Record<string, unknown>[], replay = false) {
  const deps = testDeps({
    stripe: {
      checkout: { sessions: { list: () => Promise.resolve({ data: sessions }) } },
    } as unknown as ApiDeps['stripe'],
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.profiles = [{
    id: TEST_USER,
    birth_date: '1990-01-01',
    strikes: 0,
    prefs: {},
    stripe_customer_id: 'cus_1',
  }];
  const applied: Applied[] = [];
  db.rpcHandlers.fn_apply_fulfillment = (args) => {
    applied.push(args as unknown as Applied);
    return {
      applied: !replay,
      replay,
      reason: null,
      credits: { plan: 0, pack: 1000 },
      entitlement: null,
    };
  };
  return { app: createApp(deps), applied };
}

function paidPack(over: Record<string, unknown> = {}) {
  const { metadata, ...rest } = over;
  return {
    id: 'cs_1',
    payment_status: 'paid',
    created: 1_700_000_000,
    ...rest,
    metadata: {
      pack_usd: '10',
      pack_plan: 'studio',
      ...(metadata as Record<string, unknown> ?? {}),
    },
  };
}

Deno.test('the grant comes from the catalog, not from pack_credits on the session', async () => {
  // The tampered number is what the pre-P2 route paid out verbatim.
  const { app, applied } = wired([paidPack({ metadata: { pack_credits: '999999' } })]);
  const res = await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(applied.length, 1);
  assertEquals(applied[0].p_credits, 1000);
  assertEquals(applied[0].p_txn_id, 'cs_1');
  assertEquals((await res.json()).credited, 1);
});

Deno.test('a pro buyer gets the pro rate for the same dollar size', async () => {
  const { applied, app } = wired([paidPack({ metadata: { pack_plan: 'pro' } })]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied[0].p_credits, 1250);
});

Deno.test('it settles on the SAME business transaction id as the webhook', async () => {
  const { applied, app } = wired([paidPack()]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied[0].p_source, 'stripe');
  assertEquals(applied[0].p_kind, 'pack_grant');
  assertEquals(applied[0].p_txn_id, 'cs_1');
});

Deno.test('a pack the webhook already granted is not counted or granted again', async () => {
  const { app, applied } = wired([paidPack()], true);
  const res = await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied.length, 1);
  assertEquals((await res.json()).credited, 0);
});

Deno.test('an unpaid session is never reached', async () => {
  const { app, applied } = wired([paidPack({ payment_status: 'unpaid' })]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied, []);
});

Deno.test('an uncatalogued pack size is skipped rather than settled at a guess', async () => {
  const { app, applied } = wired([paidPack({ metadata: { pack_usd: '17' } })]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied, []);
});

Deno.test('a session with no plan in force is skipped', async () => {
  const { app, applied } = wired([paidPack({ metadata: { pack_plan: undefined } })]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied, []);
});

Deno.test('a subscription checkout is not mistaken for a pack', async () => {
  const { app, applied } = wired([{
    id: 'cs_sub',
    payment_status: 'paid',
    created: 1_700_000_000,
    metadata: { user_id: TEST_USER },
  }]);
  await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(applied, []);
});

Deno.test('a failing grant is reported as a failure, never as a silent success', async () => {
  const { app } = wired([paidPack()]);
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.profiles = [{
    id: TEST_USER,
    birth_date: '1990-01-01',
    strikes: 0,
    prefs: {},
    stripe_customer_id: 'cus_1',
  }];
  db.rpcHandlers.fn_apply_fulfillment = () => {
    throw new Error('connection reset');
  };
  const failing = createApp({
    ...deps,
    stripe: {
      checkout: { sessions: { list: () => Promise.resolve({ data: [paidPack()] }) } },
    } as unknown as ApiDeps['stripe'],
  });
  const res = await failing.request('/api/billing/reconcile', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'billing_failed');
  // The healthy app still answers, proving the failure was the rpc.
  assertEquals((await app.request('/api/billing/reconcile', { method: 'POST', headers: AUTH })).status, 200);
});
