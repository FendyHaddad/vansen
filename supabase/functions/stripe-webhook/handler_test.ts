import { assertEquals } from 'jsr:@std/assert';
import type Stripe from 'npm:stripe@17';
import { FakeDb, TEST_USER } from './_shared/testing/fakes.ts';
import { packCredits } from './_shared/model-families.ts';
import { createStripeWebhook, cycleGrant } from './handler.ts';

/** What the catalog says a $10 studio pack is worth. The session fixtures below
 * deliberately carry a DIFFERENT pack_credits value to prove it is ignored. */
const PACK_10_STUDIO = packCredits(10, 'studio');

function fakeDb(): FakeDb {
  const d = new FakeDb();
  d.primaryKeys.webhook_events = 'id';
  d.tables.webhook_events = [];
  d.tables.subscriptions = [];
  d.rpcHandlers.fn_apply_fulfillment = (args, db) => {
    db.tables.applied ??= [];
    db.tables.applied.push({ ...args });
    return {
      applied: true,
      replay: false,
      reason: null,
      credits: { plan: 1500, pack: 0 },
      entitlement: args.p_plan,
    };
  };
  return d;
}

function subscription(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { user_id: TEST_USER, plan: 'studio' },
    items: { data: [{ price: { id: 'price_studio' }, current_period_end: 1790000000 }] },
    ...over,
  } as unknown as Stripe.Subscription;
}

function deps(db: FakeDb, event: Stripe.Event, sub = subscription()) {
  return {
    admin: db as never,
    constructEvent: () => Promise.resolve(event),
    retrieveSubscription: () => Promise.resolve(sub),
    // The server-recorded purchase: $10 on the studio rate.
    retrievePackPurchase: () => Promise.resolve({ usd: 10, plan: 'studio' as const }),
    priceIds: { studio: 'price_studio', pro: 'price_pro' },
  };
}

function post(): Request {
  return new Request('https://x/', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=sig' },
    body: '{}',
  });
}

function invoicePaid(id: string, over: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: `evt_${id}`,
    type: 'invoice.paid',
    created: 1790000000,
    data: {
      object: {
        id,
        subtotal: 1500,
        amount_paid: 1000,
        billing_reason: 'subscription_cycle',
        total_discount_amounts: [{ amount: 500 }],
        subscription: 'sub_1',
        lines: { has_more: false, data: [{ type: 'subscription', subscription: 'sub_1', amount: 1500, price: { id: 'price_studio' }, period: { start: 1787408000, end: 1790000000 } }] },
        ...over,
      },
    },
  } as unknown as Stripe.Event;
}

function packSession(id: string, over: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    created: 1790000000,
    data: {
      object: {
        id,
        mode: 'payment',
        payment_status: 'paid',
        amount_subtotal: 1000,
        // pack_credits is deliberately WRONG (catalog says 1000): the handler
        // must recompute from the purchase, not read this.
        metadata: { user_id: TEST_USER, pack_usd: '10', pack_credits: '1500' },
        ...over,
      },
    },
  } as unknown as Stripe.Event;
}

Deno.test('D1: a launch-coupon invoice grants the FULL plan credits', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 1000), {
    credits: 1500,
    neverLower: false,
  });
  assertEquals(cycleGrant('pro', 'subscription_create', 2500), {
    credits: 3750,
    neverLower: false,
  });
});

Deno.test('D1: a full-price invoice grants the full plan credits', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 1500), {
    credits: 1500,
    neverLower: false,
  });
});

Deno.test('D1: a prorated upgrade tops up and never lowers', () => {
  assertEquals(cycleGrant('pro', 'subscription_update', 900), {
    credits: 3750,
    neverLower: true,
  });
});

Deno.test('D1: a verified zero-amount discounted cycle receives its plan grant', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 0), {
    credits: 1500,
    neverLower: false,
  });
});

Deno.test('D1: an unrelated zero-dollar invoice does not grant', () => {
  assertEquals(cycleGrant('studio', 'manual', 0), null);
  assertEquals(cycleGrant('studio', null, 0), null);
});

Deno.test('invoice.paid uses the INVOICE id as the business transaction', async () => {
  const db = fakeDb();
  const res = await createStripeWebhook(deps(db, invoicePaid('in_42')))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals(db.tables.applied[0].p_txn_id, 'in_42');
  assertEquals(db.tables.applied[0].p_source, 'stripe');
  assertEquals(db.tables.applied[0].p_credits, 1500);
});

Deno.test('a redelivered event still reaches the idempotent rpc', async () => {
  const db = fakeDb();
  db.tables.webhook_events = [{ id: 'evt_in_42', type: 'invoice.paid' }];
  const res = await createStripeWebhook(deps(db, invoicePaid('in_42')))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
});

Deno.test('an operational db error answers 500 so stripe retries', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  const res = await createStripeWebhook(deps(db, invoicePaid('in_43')))(post());
  assertEquals(res.status, 500);
});

Deno.test('a failed run does NOT leave a delivery marker that blocks the retry', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  await createStripeWebhook(deps(db, invoicePaid('in_44')))(post());
  assertEquals(db.tables.webhook_events.filter((e) => e.id === 'evt_in_44').length, 0);
});

Deno.test('a pack checkout with a mismatched amount is refused, not silently dropped', async () => {
  const db = fakeDb();
  const res = await createStripeWebhook(
    deps(db, packSession('cs_1', { amount_subtotal: 500 })),
  )(post());
  assertEquals(res.status, 500);
  assertEquals(db.tables.applied ?? [], []);
  assertEquals(db.tables.webhook_events.filter((e) => e.id === 'evt_cs_1').length, 0);
});

Deno.test('a matching pack checkout uses the SESSION id as the business transaction', async () => {
  const db = fakeDb();
  const res = await createStripeWebhook(deps(db, packSession('cs_2')))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied[0].p_txn_id, 'cs_2');
  assertEquals(db.tables.applied[0].p_kind, 'pack_grant');
  assertEquals(db.tables.applied[0].p_credits, PACK_10_STUDIO);
});

Deno.test('tampered pack_credits metadata cannot change the granted amount', async () => {
  const db = fakeDb();
  const tampered = packSession('cs_3', {
    metadata: { user_id: TEST_USER, pack_usd: '10', pack_credits: '999999' },
  });
  const res = await createStripeWebhook(deps(db, tampered))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied[0].p_credits, PACK_10_STUDIO);
});

Deno.test('an invalid signature answers 400 and touches nothing', async () => {
  const db = fakeDb();
  const handler = createStripeWebhook({
    ...deps(db, invoicePaid('in_45')),
    constructEvent: () => Promise.reject(new Error('bad signature')),
  });
  assertEquals((await handler(post())).status, 400);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a canceled subscription never grants', async () => {
  const db = fakeDb();
  const sub = subscription({ status: 'canceled' });
  const res = await createStripeWebhook(deps(db, invoicePaid('in_46'), sub))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('an unrecognized subscription price halts the grant instead of guessing', async () => {
  const db = fakeDb();
  const sub = subscription({
    items: { data: [{ price: { id: 'price_mystery' }, current_period_end: 1790000000 }] },
  });
  const res = await createStripeWebhook(deps(db, invoicePaid('in_47'), sub))(post());
  assertEquals(res.status, 500);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('late distinct invoice retains invoiced plan and period after a newer cycle', async () => {
  const db = fakeDb();
  const current = subscription({ items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1797948800 }] } });
  const newer = invoicePaid('in_new', { lines: { has_more: false, data: [{ type: 'subscription', subscription: 'sub_1', amount: 3750, price: { id: 'price_pro' }, period: { start: 1795356800, end: 1797948800 } }] } });
  assertEquals((await createStripeWebhook(deps(db, newer, current))(post())).status, 200);
  assertEquals((await createStripeWebhook(deps(db, invoicePaid('in_old'), current))(post())).status, 200);
  assertEquals(db.tables.applied[1].p_period_end, '2026-09-21T14:13:20.000Z');
  assertEquals(db.tables.applied[1].p_plan, 'studio');
  assertEquals(db.tables.applied[1].p_credits, 1500);
  assertEquals(db.tables.applied[1].p_entitlement, null);
  assertEquals(db.tables.subscriptions[0].plan, 'pro');
});

Deno.test('modern invoice upgrade selects the positive new-plan line, not the credit', async () => {
  const db = fakeDb();
  const event = invoicePaid('in_upgrade', { billing_reason: 'subscription_update', lines: { has_more: false, data: [
    { amount: -500, parent: { subscription_item_details: { subscription: 'sub_1' } }, pricing: { price_details: { price: 'price_studio' } }, period: { end: 1790000000 } },
    { amount: 1250, parent: { subscription_item_details: { subscription: 'sub_1' } }, pricing: { price_details: { price: 'price_pro' } }, period: { end: 1790000000 } },
  ] } });
  assertEquals((await createStripeWebhook(deps(db, event))(post())).status, 200);
  assertEquals(db.tables.applied[0].p_plan, 'pro');
  assertEquals(db.tables.applied[0].p_never_lower, true);
});

Deno.test('missing or incomplete invoice lines retry instead of guessing from current subscription', async () => {
  for (const lines of [undefined, { data: [], has_more: false }, { data: [], has_more: true }]) {
    const db = fakeDb();
    assertEquals((await createStripeWebhook(deps(db, invoicePaid('in_missing', { lines })))(post())).status, 500);
    assertEquals(db.tables.applied ?? [], []);
  }
});

Deno.test('verified invoice survives subscription retrieval failure in the receipt inbox', async () => {
  const db = fakeDb();
  const res = await createStripeWebhook({ ...deps(db, invoicePaid('in_prepare')), retrieveSubscription: () => Promise.reject(new Error('stripe unavailable')) })(post());
  assertEquals(res.status, 500);
  assertEquals(db.rpcCalls.filter(c => c.name === 'fn_record_billing_delivery').length, 1);
  assertEquals(db.rpcCalls.find(c => c.name === 'fn_record_billing_delivery')?.args.p_txn_id, 'in_prepare');
});
Deno.test('verified invoice survives mirror failure in the receipt inbox', async () => {
  const db = fakeDb();
  db.failNext('subscriptions.upsert', 'database unavailable');
  assertEquals((await createStripeWebhook(deps(db, invoicePaid('in_mirror')))(post())).status, 500);
  assertEquals(db.rpcCalls.some(c => c.name === 'fn_record_billing_delivery'), true);
  assertEquals(db.rpcCalls.some(c => c.name === 'fn_apply_fulfillment'), false);
});
