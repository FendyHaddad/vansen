// Cross-rail billing: an App Store subscription is never sold a second time
// through Stripe, is managed in the App Store, and does not collect the
// Stripe launch offer. /profile says which rail wrote the row.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import type { ApiDeps } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface StripeCall {
  path: string;
  args: unknown[];
}

/** Records every Stripe method called, answering with canned values. */
function recordingStripe(opts: { history?: Record<string, unknown>[] } = {}) {
  const calls: StripeCall[] = [];
  const answers: Record<string, unknown> = {
    'customers.create': { id: 'cus_new' },
    'subscriptions.list': { data: opts.history ?? [] },
    'subscriptions.update': {},
    'checkout.sessions.create': { url: 'https://checkout.stripe.test/s' },
    'billingPortal.sessions.create': { url: 'https://portal.stripe.test/p' },
  };
  function node(path: string): unknown {
    return new Proxy(function () {}, {
      get: (_t, key) => node(path ? `${path}.${String(key)}` : String(key)),
      apply: (_t, _this, args) => {
        calls.push({ path, args });
        return Promise.resolve(answers[path] ?? {});
      },
    });
  }
  return { stripe: node('') as ApiDeps['stripe'], calls };
}

function setup(
  row: Record<string, unknown> | null,
  opts: { history?: Record<string, unknown>[]; coupon?: string } = {},
) {
  const recorder = recordingStripe(opts);
  const base = testDeps();
  const deps = testDeps({
    stripe: recorder.stripe,
    env: { ...base.env, launchCouponId: opts.coupon },
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = row
    ? [{
      user_id: TEST_USER,
      plan: 'studio',
      pending_plan: null,
      pending_at: null,
      stripe_subscription_id: null,
      iap_original_transaction_id: null,
      ...row,
    }]
    : [];
  db.tables.billing_transactions = [];
  return { app: createApp(deps), db, calls: recorder.calls };
}

const APPLE_ACTIVE = {
  status: 'active',
  current_period_end: iso(20 * DAY),
  iap_original_transaction_id: 'otx_1',
};
const STRIPE_ACTIVE = {
  status: 'active',
  current_period_end: iso(20 * DAY),
  stripe_subscription_id: 'sub_1',
};
/** Both rails wrote the row: the double-subscribed user of review C1. */
const BOTH_IDS = { ...STRIPE_ACTIVE, iap_original_transaction_id: 'otx_1' };

function grantRow(source: string, txn: string, appliedAt: string, periodEnd: string) {
  return {
    user_id: TEST_USER,
    source,
    business_txn_id: txn,
    kind: 'subscription_grant',
    applied_at: appliedAt,
    period_end: periodEnd,
    result: { applied: true, replay: false, reason: null },
  };
}

/** Apple's grant pays for the latest period, so the source reads app_store. */
const APPLE_PAYS_LATEST = [
  grantRow('stripe', 'in_1', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  grantRow('apple', 'atx_1', '2026-09-01T00:00:00Z', iso(25 * DAY)),
];

/** A subscription Stripe still bills. */
const LIVE_STRIPE = {
  id: 'sub_1',
  status: 'active',
  cancel_at_period_end: false,
  metadata: {},
  schedule: null,
  items: { data: [{ id: 'si_1', price: { id: 'price_studio' } }] },
};

function post(app: ReturnType<typeof createApp>, path: string, body: unknown = {}) {
  return app.request(`/api${path}`, {
    method: 'POST',
    headers: { ...AUTH, 'x-vansen-client': 'web' },
    body: JSON.stringify(body),
  });
}

async function profileOf(row: Record<string, unknown> | null) {
  const { app } = setup(row);
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals(res.status, 200);
  return await res.json();
}

// ── #3: GET /profile subscriptionSource ─────────────────────────────────────

Deno.test('/profile: no subscription row → subscriptionSource null', async () => {
  const body = await profileOf(null);
  assertEquals(body.subscriptionSource, null);
  assertEquals(body.subscription, null);
});

Deno.test('/profile: a Stripe row → "stripe"', async () => {
  assertEquals((await profileOf(STRIPE_ACTIVE)).subscriptionSource, 'stripe');
});

Deno.test('/profile: an App Store row → "app_store", whatever its status', async () => {
  assertEquals((await profileOf(APPLE_ACTIVE)).subscriptionSource, 'app_store');
  const expired = await profileOf({ ...APPLE_ACTIVE, status: 'expired', current_period_end: iso(-DAY) });
  assertEquals(expired.subscriptionSource, 'app_store');
  assertEquals(expired.subscription.entitled, false);
});

Deno.test('/profile: an owner grant (neither rail) → "stripe", never app_store', async () => {
  const body = await profileOf({ plan: 'owner', status: 'active', current_period_end: null });
  assertEquals(body.subscriptionSource, 'stripe');
});

Deno.test('/profile: a row both rails wrote follows the latest subscription grant', async () => {
  const { app, db } = setup(BOTH_IDS);
  db.tables.billing_transactions = APPLE_PAYS_LATEST;
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals((await res.json()).subscriptionSource, 'app_store');
});

Deno.test('/profile: a stale Apple redelivery does not take a Stripe row (I1)', async () => {
  const { app, db } = setup(BOTH_IDS);
  db.tables.billing_transactions = [
    grantRow('stripe', 'in_1', '2026-09-01T00:00:00Z', iso(20 * DAY)),
    {
      ...grantRow('apple', 'atx_old', '2026-09-20T00:00:00Z', '2026-08-01T00:00:00Z'),
      result: { applied: false, replay: false, reason: 'stale_period' },
    },
  ];
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals((await res.json()).subscriptionSource, 'stripe');
});

Deno.test('/profile: a failed tie-break read falls back instead of failing /profile (M2)', async () => {
  const { app, db } = setup(BOTH_IDS);
  db.failNext('billing_transactions.select', 'boom');
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).subscriptionSource, 'stripe');
});

Deno.test('/profile: entitled honours the 3-day grace on an active row', async () => {
  const late = await profileOf({ ...APPLE_ACTIVE, current_period_end: iso(-2 * DAY) });
  assertEquals(late.subscription.entitled, true);
  const gone = await profileOf({ ...APPLE_ACTIVE, current_period_end: iso(-4 * DAY) });
  assertEquals(gone.subscription.entitled, false);
});

// ── #2: no second subscription through Stripe ───────────────────────────────

Deno.test('subscribe: an entitled App Store subscription is refused 409 and Stripe is never called', async () => {
  const { app, db, calls } = setup(APPLE_ACTIVE);
  const res = await post(app, '/billing/subscribe', { plan: 'pro' });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'subscribed_in_app_store');
  assertEquals(calls, []);
  assertEquals(db.tables.profiles[0].stripe_customer_id, undefined);
});

Deno.test('subscribe: a failed subscription read refuses checkout instead of failing open (M1)', async () => {
  const { app, db, calls } = setup(APPLE_ACTIVE);
  db.failNext('subscriptions.select', 'boom');
  const res = await post(app, '/billing/subscribe', { plan: 'pro' });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'billing_failed');
  assertEquals(calls, []);
});

Deno.test('subscribe: an App Store row canceled inside its period is still refused', async () => {
  const { app, calls } = setup({ ...APPLE_ACTIVE, status: 'canceled' });
  const res = await post(app, '/billing/subscribe', { plan: 'studio' });
  assertEquals(res.status, 409);
  assertEquals(calls, []);
});

Deno.test('subscribe: a lapsed App Store subscription may subscribe through Stripe, without the launch offer', async () => {
  const { app, calls } = setup(
    { ...APPLE_ACTIVE, status: 'expired', current_period_end: iso(-10 * DAY) },
    { coupon: 'LAUNCH' },
  );
  const res = await post(app, '/billing/subscribe', { plan: 'studio' });
  assertEquals(res.status, 200);
  const session = calls.find((c) => c.path === 'checkout.sessions.create');
  assertEquals((session?.args[0] as { discounts?: unknown }).discounts, undefined);
});

Deno.test('subscribe: a first-time buyer with no App Store history still gets the launch offer', async () => {
  const { app, calls } = setup(null, { coupon: 'LAUNCH' });
  const res = await post(app, '/billing/subscribe', { plan: 'studio' });
  assertEquals(res.status, 200);
  const session = calls.find((c) => c.path === 'checkout.sessions.create');
  assertEquals((session?.args[0] as { discounts?: unknown }).discounts, [{ coupon: 'LAUNCH' }]);
});

// ── #3: Stripe management endpoints refuse App Store rows ───────────────────

for (const path of ['/billing/cancel', '/billing/portal', '/billing/resume', '/billing/change-plan']) {
  Deno.test(`${path}: an App Store row answers 409 managed_in_app_store with no Stripe call`, async () => {
    const { app, calls } = setup(APPLE_ACTIVE);
    const res = await post(app, path, { plan: 'pro', when: 'now', reason: 'too_expensive' });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error.code, 'managed_in_app_store');
    assertEquals(calls, []);
  });
}

Deno.test('/billing/cancel: an expired App Store row is still managed in the App Store', async () => {
  const { app, calls } = setup({ ...APPLE_ACTIVE, status: 'expired' });
  const res = await post(app, '/billing/cancel', { reason: 'x' });
  assertEquals(res.status, 409);
  assertEquals(calls, []);
});

// ── C1: a row with a Stripe subscription id lets Stripe answer ──────────────

Deno.test('/billing/cancel: both ids, Apple latest, live Stripe → Stripe is cancelled (C1)', async () => {
  const { app, db, calls } = setup(BOTH_IDS, { history: [LIVE_STRIPE] });
  db.tables.billing_transactions = APPLE_PAYS_LATEST;
  const res = await post(app, '/billing/cancel', { reason: 'double_billed' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { cancelAtPeriodEnd: true });
  const update = calls.find((c) => c.path === 'subscriptions.update');
  assertEquals(update?.args[0], 'sub_1');
  assertEquals((update?.args[1] as { cancel_at_period_end: boolean }).cancel_at_period_end, true);
});

Deno.test('/billing/resume: both ids, Apple latest, live Stripe → reaches Stripe (C1)', async () => {
  const { app, db, calls } = setup(BOTH_IDS, {
    history: [{ ...LIVE_STRIPE, cancel_at_period_end: true }],
  });
  db.tables.billing_transactions = APPLE_PAYS_LATEST;
  const res = await post(app, '/billing/resume');
  assertEquals(res.status, 200);
  assertEquals(calls.some((c) => c.path === 'subscriptions.update'), true);
});

Deno.test('/billing/portal: both ids, Apple latest → opens the Stripe portal (C1)', async () => {
  const { app, db, calls } = setup(BOTH_IDS);
  db.tables.billing_transactions = APPLE_PAYS_LATEST;
  const res = await post(app, '/billing/portal');
  assertEquals(res.status, 200);
  assertEquals(calls.some((c) => c.path === 'billingPortal.sessions.create'), true);
});

for (const path of ['/billing/cancel', '/billing/resume', '/billing/change-plan']) {
  Deno.test(`${path}: both ids, Apple latest, nothing live in Stripe → 409 managed_in_app_store`, async () => {
    const { app, db, calls } = setup(BOTH_IDS);
    db.tables.billing_transactions = APPLE_PAYS_LATEST;
    const res = await post(app, path, { plan: 'pro', when: 'now', reason: 'x' });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error.code, 'managed_in_app_store');
    assertEquals(calls.some((c) => c.path === 'subscriptions.update'), false);
  });
}

Deno.test('/billing/overview: both ids, Apple latest → reads Stripe and reports the live subscription', async () => {
  const { app, db, calls } = setup(BOTH_IDS, { history: [LIVE_STRIPE] });
  db.tables.billing_transactions = APPLE_PAYS_LATEST;
  const res = await app.request('/api/billing/overview', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).stripeSubscription, true);
  assertEquals(calls.some((c) => c.path === 'subscriptions.list'), true);
});

Deno.test('/billing/cancel: a Stripe row still reaches Stripe', async () => {
  const { app, calls } = setup(STRIPE_ACTIVE);
  const res = await post(app, '/billing/cancel', { reason: 'x' });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'no_subscription');
  assertEquals(calls.some((c) => c.path === 'subscriptions.list'), true);
});

Deno.test('/billing/portal: no row still opens the Stripe portal', async () => {
  const { app, calls } = setup(null);
  const res = await post(app, '/billing/portal');
  assertEquals(res.status, 200);
  assertEquals(calls.some((c) => c.path === 'billingPortal.sessions.create'), true);
});

// ── #15: overview creates no Stripe customer for an App Store user ─────────

Deno.test('/billing/overview: an App Store user gets the empty overview and no Stripe customer', async () => {
  const { app, db, calls } = setup(APPLE_ACTIVE);
  const res = await app.request('/api/billing/overview', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    cancelAtPeriodEnd: false,
    upcoming: null,
    paymentMethod: null,
    stripeSubscription: false,
  });
  assertEquals(calls, []);
  assertEquals(db.tables.profiles[0].stripe_customer_id, undefined);
});

Deno.test('/billing/overview: a Stripe user still reads from Stripe', async () => {
  const { app, calls } = setup(STRIPE_ACTIVE);
  const res = await app.request('/api/billing/overview', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(calls.some((c) => c.path === 'subscriptions.list'), true);
});
