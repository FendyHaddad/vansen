import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function subscribed(db: FakeDb) {
  db.tables.subscriptions = [
    {
      user_id: TEST_USER,
      plan: 'studio',
      status: 'active',
      current_period_end: '2099-01-01T00:00:00Z',
    },
  ];
}

function body(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ plan: 'studio', ...extra });
}

Deno.test('an iOS client in a lane-C storefront cannot start a stripe subscription', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'x-vansen-client': 'ios',
      'x-vansen-storefront': 'JP',
    },
    body: body(),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('an iOS client with NO storefront header is refused, not treated as US', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'ios' },
    body: body(),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('an iOS client in a lane-A storefront may use stripe', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'x-vansen-client': 'ios',
      'x-vansen-storefront': 'US',
    },
    body: body(),
  });
  // Reaches Stripe (which the fake does not implement) rather than being
  // refused by the lane gate.
  assertEquals(res.status === 403, false);
});

Deno.test('the web client is never lane-gated', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'web' },
    body: body(),
  });
  assertEquals(res.status === 403, false);
});

Deno.test('packs are lane-gated the same way', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  subscribed(db);
  const app = createApp(deps);
  const res = await app.request('/api/billing/pack', {
    method: 'POST',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'x-vansen-client': 'ios',
      'x-vansen-storefront': 'JP',
    },
    body: JSON.stringify({ usd: 10 }),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('GET /billing/lane refuses to guess an unknown storefront', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/billing/lane?platform=ios', { headers: AUTH });
  assertEquals((await res.json()).lane, 'C');
});

Deno.test('GET /billing/lane does not read an unknown platform as android', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/billing/lane?platform=wat', { headers: AUTH });
  assertEquals((await res.json()).lane, 'C');
});
