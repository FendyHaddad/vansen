import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from '../testing/fakes.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  appStoreEverRecorded,
  railOf,
  subscriptionSourceOf,
} from './subscription-source.ts';

const STRIPE_ONLY = { stripe_subscription_id: 'sub_1', iap_original_transaction_id: null };
const APPLE_ONLY = { stripe_subscription_id: null, iap_original_transaction_id: 'otx_1' };
const BOTH = { stripe_subscription_id: 'sub_1', iap_original_transaction_id: 'otx_1' };
const NEITHER = { stripe_subscription_id: null, iap_original_transaction_id: null };

function dbWith(grants: { source: string; applied_at: string; kind?: string; user_id?: string }[]) {
  const db = new FakeDb();
  db.tables.billing_transactions = grants.map((g) => ({
    user_id: TEST_USER,
    kind: 'subscription_grant',
    ...g,
  }));
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

Deno.test('a row both rails wrote belongs to whichever granted last', () => {
  assertEquals(railOf(BOTH, 'apple'), 'app_store');
  assertEquals(railOf(BOTH, 'stripe'), 'stripe');
  assertEquals(railOf(BOTH, null), 'stripe');
});

Deno.test('subscriptionSourceOf reads the latest subscription grant only when both rails wrote the row', async () => {
  const db = dbWith([
    { source: 'stripe', applied_at: '2026-08-01T00:00:00Z' },
    { source: 'apple', applied_at: '2026-09-01T00:00:00Z' },
    { source: 'stripe', applied_at: '2026-09-10T00:00:00Z', kind: 'pack_grant' },
    { source: 'stripe', applied_at: '2026-09-20T00:00:00Z', user_id: 'someone-else' },
  ]);
  const admin = db as unknown as SupabaseClient;
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, BOTH), 'app_store');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, STRIPE_ONLY), 'stripe');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, APPLE_ONLY), 'app_store');
  assertEquals(await subscriptionSourceOf(admin, TEST_USER, null), null);
});

Deno.test('subscriptionSourceOf: a later Stripe grant takes the row back', async () => {
  const db = dbWith([
    { source: 'apple', applied_at: '2026-08-01T00:00:00Z' },
    { source: 'stripe', applied_at: '2026-09-01T00:00:00Z' },
  ]);
  assertEquals(await subscriptionSourceOf(db as unknown as SupabaseClient, TEST_USER, BOTH), 'stripe');
});

Deno.test('subscriptionSourceOf raises a failed read instead of guessing', async () => {
  const db = dbWith([]);
  db.failNext('billing_transactions.select', 'boom');
  await assertRejects(() => subscriptionSourceOf(db as unknown as SupabaseClient, TEST_USER, BOTH));
});

Deno.test('appStoreEverRecorded: any Apple original transaction on the row', () => {
  assertEquals(appStoreEverRecorded(null), false);
  assertEquals(appStoreEverRecorded(STRIPE_ONLY), false);
  assertEquals(appStoreEverRecorded(NEITHER), false);
  assertEquals(appStoreEverRecorded(APPLE_ONLY), true);
  assertEquals(appStoreEverRecorded(BOTH), true);
});
