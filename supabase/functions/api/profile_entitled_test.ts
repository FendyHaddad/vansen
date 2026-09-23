import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function subscriptionFor(row: Record<string, unknown> | null) {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = row
    ? [{ user_id: TEST_USER, plan: 'studio', pending_plan: null, pending_at: null, ...row }]
    : [];
  const res = await createApp(deps).request('/api/profile', { headers: AUTH });
  assertEquals(res.status, 200);
  return (await res.json()).subscription;
}

Deno.test('an active subscription is entitled', async () => {
  const sub = await subscriptionFor({ status: 'active', current_period_end: iso(DAY) });
  assertEquals(sub.entitled, true);
});

Deno.test('a canceled subscription stays entitled until its period ends', async () => {
  const sub = await subscriptionFor({ status: 'canceled', current_period_end: iso(DAY) });
  assertEquals(sub.entitled, true);
});

Deno.test('a canceled subscription past its period is not entitled', async () => {
  const sub = await subscriptionFor({ status: 'canceled', current_period_end: iso(-DAY) });
  assertEquals(sub.entitled, false);
});

Deno.test('an expired subscription is not entitled', async () => {
  const sub = await subscriptionFor({ status: 'expired', current_period_end: iso(-DAY) });
  assertEquals(sub.entitled, false);
});

Deno.test('no subscription row still reads as null', async () => {
  assertEquals(await subscriptionFor(null), null);
});
