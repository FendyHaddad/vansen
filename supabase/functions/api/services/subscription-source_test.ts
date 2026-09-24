import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from '../testing/fakes.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  appStoreEverRecorded,
  appStoreOnly,
  currentGrantRail,
  type GrantRow,
  railOf,
  subscriptionSourceOf,
} from './subscription-source.ts';

const STRIPE_ONLY = { stripe_subscription_id: 'sub_1', iap_original_transaction_id: null };
const APPLE_ONLY = { stripe_subscription_id: null, iap_original_transaction_id: 'otx_1' };
const BOTH = { stripe_subscription_id: 'sub_1', iap_original_transaction_id: 'otx_1' };
const NEITHER = { stripe_subscription_id: null, iap_original_transaction_id: null };

let seq = 0;
/** A subscription grant as fn_apply_fulfillment records it; applied unless told otherwise. */
type GrantInput = Omit<Partial<GrantRow>, 'result'> & {
  source: string;
  applied_at: string;
  result?: Record<string, unknown>;
  kind?: string;
  user_id?: string;
};

function grant(over: GrantInput): GrantRow & Record<string, unknown> {
  seq += 1;
  return {
    user_id: TEST_USER,
    kind: 'subscription_grant',
    business_txn_id: `txn_${seq}`,
    period_end: over.applied_at,
    result: { applied: true, replay: false, reason: null },
    ...over,
  };
}

function dbWith(grants: Record<string, unknown>[]) {
  const db = new FakeDb();
  db.tables.billing_transactions = grants;
  return db;
}

Deno.test('no row has no source', () => {
  assertEquals(railOf(null, null), null);
  assertEquals(railOf(undefined, null), null);
});

Deno.test('a row only Stripe ever wrote is stripe; only Apple is app_store', () => {
  assertEquals(railOf(STRIPE_ONLY, null), 'stripe');
  assertEquals(railOf(APPLE_ONLY, null), 'app_store');
});

Deno.test('a row neither rail wrote (owner grant) reads as stripe, never app_store', () => {
  assertEquals(railOf(NEITHER, null), 'stripe');
});

Deno.test('an owner row reads as stripe even when it once carried an App Store id', () => {
  assertEquals(railOf({ ...APPLE_ONLY, plan: 'owner' }, null), 'stripe');
  assertEquals(railOf({ ...BOTH, plan: 'owner' }, 'apple'), 'stripe');
  assertEquals(appStoreOnly({ ...APPLE_ONLY, plan: 'owner' }), false);
});

Deno.test('a row both rails wrote belongs to whichever granted last', () => {
  assertEquals(railOf(BOTH, 'apple'), 'app_store');
  assertEquals(railOf(BOTH, 'stripe'), 'stripe');
  assertEquals(railOf(BOTH, null), 'stripe');
});

Deno.test('appStoreOnly: an App Store id and no Stripe subscription id', () => {
  assertEquals(appStoreOnly(APPLE_ONLY), true);
  assertEquals(appStoreOnly(BOTH), false);
  assertEquals(appStoreOnly(STRIPE_ONLY), false);
  assertEquals(appStoreOnly(NEITHER), false);
  assertEquals(appStoreOnly(null), false);
});

Deno.test('subscriptionSourceOf reads the grants only when both rails wrote the row', async () => {
  const db = dbWith([
    grant({ source: 'stripe', applied_at: '2026-08-01T00:00:00Z' }),
    grant({ source: 'apple', applied_at: '2026-09-01T00:00:00Z' }),
    grant({ source: 'stripe', applied_at: '2026-09-10T00:00:00Z', kind: 'pack_grant' }),
    grant({ source: 'stripe', applied_at: '2026-09-20T00:00:00Z', user_id: 'someone-else' }),
  ]);
  const admin = db as unknown as SupabaseClient;
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, BOTH), 'app_store');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, STRIPE_ONLY), 'stripe');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, APPLE_ONLY), 'app_store');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, null), null);
});

Deno.test('subscriptionSourceOf: a later Stripe grant takes the row back', async () => {
  const db = dbWith([
    grant({ source: 'apple', applied_at: '2026-08-01T00:00:00Z' }),
    grant({ source: 'stripe', applied_at: '2026-09-01T00:00:00Z' }),
  ]);
  assertEquals(await subscriptionSourceOf(db as unknown as SupabaseClient, TEST_USER, BOTH), 'stripe');
});

Deno.test('subscriptionSourceOf raises a failed read instead of guessing', async () => {
  const db = dbWith([]);
  db.failNext('billing_transactions.select', 'boom');
  await assertRejects(() => subscriptionSourceOf(db as unknown as SupabaseClient, TEST_USER, BOTH));
});

// ── I1: only successful, current grants decide ─────────────────────────────

const STRIPE_PAID = { source: 'stripe', applied_at: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z' };

Deno.test('a stale_period Apple row (Restore of an old renewal) does not flip a Stripe row', () => {
  const rows = [
    grant(STRIPE_PAID),
    grant({
      source: 'apple',
      applied_at: '2026-09-15T00:00:00Z',
      period_end: '2026-08-10T00:00:00Z',
      result: { applied: false, replay: false, reason: 'stale_period' },
    }),
  ];
  assertEquals(currentGrantRail(rows), 'stripe');
});

Deno.test('a legacy_ledger_ref replay row does not count', () => {
  const rows = [
    grant(STRIPE_PAID),
    grant({
      source: 'apple',
      applied_at: '2026-09-15T00:00:00Z',
      period_end: '2026-11-01T00:00:00Z',
      result: { applied: false, replay: true, reason: 'legacy_ledger_ref' },
    }),
  ];
  assertEquals(currentGrantRail(rows), 'stripe');
});

Deno.test('an Apple refund row does not count, and the grant it refunded no longer counts either', () => {
  const rows = [
    grant({ source: 'apple', business_txn_id: 'atx_9', applied_at: '2026-09-10T00:00:00Z', period_end: '2026-10-10T00:00:00Z' }),
    grant(STRIPE_PAID),
    grant({ source: 'apple', business_txn_id: 'refund:atx_9', applied_at: '2026-09-12T00:00:00Z', period_end: null }),
  ];
  assertEquals(currentGrantRail(rows), 'stripe');
});

Deno.test('the grant paying for the latest period wins, not the latest write', () => {
  const rows = [
    grant({ source: 'stripe', applied_at: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z' }),
    grant({ source: 'apple', applied_at: '2026-09-05T00:00:00Z', period_end: '2026-09-20T00:00:00Z' }),
  ];
  assertEquals(currentGrantRail(rows), 'stripe');
});

Deno.test('equal periods fall back to the latest write', () => {
  const rows = [
    grant({ source: 'stripe', applied_at: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z' }),
    grant({ source: 'apple', applied_at: '2026-09-05T00:00:00Z', period_end: '2026-10-01T00:00:00Z' }),
  ];
  assertEquals(currentGrantRail(rows), 'apple');
});

Deno.test('no successful grant at all: no rail', () => {
  assertEquals(currentGrantRail([]), null);
  assertEquals(
    currentGrantRail([grant({ source: 'apple', applied_at: '2026-09-01T00:00:00Z', result: { applied: false } })]),
    null,
  );
});

Deno.test('subscriptionSourceOf applies the same rule end to end', async () => {
  const db = dbWith([
    grant(STRIPE_PAID),
    grant({
      source: 'apple',
      applied_at: '2026-09-20T00:00:00Z',
      period_end: '2026-08-01T00:00:00Z',
      result: { applied: false, replay: false, reason: 'stale_period' },
    }),
  ]);
  assertEquals(await subscriptionSourceOf(db as unknown as SupabaseClient, TEST_USER, BOTH), 'stripe');
});

Deno.test('appStoreEverRecorded: any Apple original transaction on the row', () => {
  assertEquals(appStoreEverRecorded(null), false);
  assertEquals(appStoreEverRecorded(STRIPE_ONLY), false);
  assertEquals(appStoreEverRecorded(NEITHER), false);
  assertEquals(appStoreEverRecorded(APPLE_ONLY), true);
  assertEquals(appStoreEverRecorded(BOTH), true);
});
