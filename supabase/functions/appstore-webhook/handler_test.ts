import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from './_shared/testing/fakes.ts';
import { createAppstoreWebhook } from './handler.ts';

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

const NOTIFICATION = {
  notificationUUID: 'uuid-1',
  notificationType: 'SUBSCRIBED',
  subtype: 'INITIAL_BUY',
  data: { signedTransactionInfo: 'jws' },
};

/** Always in the future relative to the test run, so expiry is never flaky. */
const FUTURE = Date.now() + 30 * 86400 * 1000;

function deps(db: FakeDb, over: Record<string, unknown> = {}) {
  return {
    admin: db as never,
    verifyNotification: () => Promise.resolve(NOTIFICATION),
    verifyTransaction: () =>
      Promise.resolve({
        productId: 'vansen.studio.monthly',
        transactionId: 'tx_1',
        originalTransactionId: 'otx_1',
        expiresDate: FUTURE,
        appAccountToken: TEST_USER,
      }),
    ...over,
  };
}

function post(): Request {
  return new Request('https://x/', {
    method: 'POST',
    body: JSON.stringify({ signedPayload: 'jws' }),
  });
}

Deno.test('a subscription notification grants once, keyed on the apple transaction id', async () => {
  const db = fakeDb();
  const res = await createAppstoreWebhook(deps(db))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals(db.tables.applied[0].p_source, 'apple');
  assertEquals(db.tables.applied[0].p_txn_id, 'tx_1');
  assertEquals(db.tables.applied[0].p_credits, 1500);
});

Deno.test('a failed grant leaves NO marker that would skip the retry', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  const res = await createAppstoreWebhook(deps(db))(post());
  assertEquals(res.status, 500);
  assertEquals(db.tables.webhook_events, []);
  // The retry must reach the rpc again.
  const retry = await createAppstoreWebhook(deps(db))(post());
  assertEquals(retry.status, 200);
  assertEquals(db.tables.applied.length, 1);
});

Deno.test('a replayed notification is answered 200 without a second grant', async () => {
  const db = fakeDb();
  let calls = 0;
  db.rpcHandlers.fn_apply_fulfillment = (args) => {
    calls += 1;
    if (calls === 1) {
      return {
        applied: true,
        replay: false,
        reason: null,
        credits: { plan: 1500, pack: 0 },
        entitlement: args.p_plan,
      };
    }
    return {
      applied: false,
      replay: true,
      reason: null,
      credits: { plan: 1500, pack: 0 },
      entitlement: args.p_plan,
    };
  };
  assertEquals((await createAppstoreWebhook(deps(db))(post())).status, 200);
  assertEquals((await createAppstoreWebhook(deps(db))(post())).status, 200);
  assertEquals(calls, 2);
});

Deno.test('an unknown product is ignored, not granted', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.unknown',
          transactionId: 'tx_2',
          originalTransactionId: 'otx_2',
          appAccountToken: TEST_USER,
        }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a revoked transaction is rejected, not granted', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.studio.monthly',
          transactionId: 'tx_3',
          originalTransactionId: 'otx_3',
          expiresDate: FUTURE,
          revocationDate: Date.now(),
          appAccountToken: TEST_USER,
        }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('an already-expired subscription is rejected, not granted', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.studio.monthly',
          transactionId: 'tx_4',
          originalTransactionId: 'otx_4',
          expiresDate: Date.now() - 1000,
          appAccountToken: TEST_USER,
        }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a subscription with no expiry is refused rather than given a fabricated period', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.studio.monthly',
          transactionId: 'tx_5',
          originalTransactionId: 'otx_5',
          appAccountToken: TEST_USER,
        }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('an invalid signature answers 401 and touches nothing', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, { verifyNotification: () => Promise.reject(new Error('bad chain')) }),
  );
  assertEquals((await handler(post())).status, 401);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a status-only notification updates the mirror without granting', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [
    {
      user_id: TEST_USER,
      plan: 'studio',
      status: 'active',
      iap_original_transaction_id: 'otx_1',
    },
  ];
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyNotification: () =>
        Promise.resolve({ ...NOTIFICATION, notificationType: 'EXPIRED', subtype: 'VOLUNTARY' }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.subscriptions[0].status, 'expired');
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a failed mirror write answers 500 so apple retries', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [
    {
      user_id: TEST_USER,
      plan: 'studio',
      status: 'active',
      iap_original_transaction_id: 'otx_1',
    },
  ];
  db.failNext('subscriptions.update', 'connection reset');
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyNotification: () =>
        Promise.resolve({ ...NOTIFICATION, notificationType: 'EXPIRED', subtype: 'VOLUNTARY' }),
    }),
  );
  assertEquals((await handler(post())).status, 500);
});

Deno.test('a stale legacy iaptx: marker no longer suppresses the grant', async () => {
  const db = fakeDb();
  // The pre-P2 failure mode: the marker landed, the grant did not, and every
  // later delivery returned early. Nothing reads this key any more.
  db.tables.webhook_events = [{ id: 'iaptx:tx_1', type: 'iap_transaction' }];
  const res = await createAppstoreWebhook(deps(db))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals(db.tables.applied[0].p_txn_id, 'tx_1');
});

function refundDeps(db: FakeDb, token: string | undefined = TEST_USER) {
  return deps(db, {
    verifyNotification: () => Promise.resolve({ ...NOTIFICATION, notificationType: 'REFUND' }),
    verifyTransaction: () => Promise.resolve({ productId: 'vansen.pack.s', transactionId: 'old_tx', originalTransactionId: 'old_tx', appAccountToken: token }),
  });
}
Deno.test('historical pack refund reaches clawback through the signed notification handler', async () => {
  const db = fakeDb();
  db.tables.ledger_entries = [{ user_id: TEST_USER, stripe_ref: 'iap:old_tx', amount_credits: 1234 }];
  assertEquals((await createAppstoreWebhook(refundDeps(db))(post())).status, 200);
  assertEquals(db.tables.applied[0].p_kind, 'clawback');
  assertEquals(db.tables.applied[0].p_credits, 1234);
});
Deno.test('refund grant lookup failure returns 500, without an acknowledgment marker', async () => {
  const db = fakeDb();
  db.failNext('ledger_entries.select', 'database unavailable');
  assertEquals((await createAppstoreWebhook(refundDeps(db))(post())).status, 500);
  assertEquals(db.tables.webhook_events, []);
});
Deno.test('refund account lookup failure also returns 500', async () => {
  const db = fakeDb();
  db.failNext('subscriptions.select', 'database unavailable');
  const dep = { ...refundDeps(db), verifyTransaction: () => Promise.resolve({ productId: 'vansen.pack.s', transactionId: 'old_tx', originalTransactionId: 'old_tx' }) };
  assertEquals((await createAppstoreWebhook(dep)(post())).status, 500);
});
Deno.test('verified Apple refund survives account lookup failure in the inbox', async () => {
  const db = fakeDb();
  db.failNext('subscriptions.select', 'database unavailable');
  const dep = { ...refundDeps(db), verifyTransaction: () => Promise.resolve({ productId: 'vansen.pack.s', transactionId: 'old_tx', originalTransactionId: 'old_tx' }) };
  assertEquals((await createAppstoreWebhook(dep)(post())).status, 500);
  assertEquals(db.rpcCalls.some(c => c.name === 'fn_record_billing_delivery' && c.args.p_txn_id === 'refund:old_tx'), true);
});

// ── I4: Apple end-of-life events never end a period Stripe is paying for ────

const DAY_MS = 86_400_000;
const APPLE_ENDED = Date.now() - 5 * DAY_MS;
const STRIPE_PAID_TO = new Date(Date.now() + 25 * DAY_MS).toISOString();

/** Lapsed on Apple, then subscribed through Stripe: both ids on one row. */
function stripeCarriedRow(status = 'active') {
  return {
    user_id: TEST_USER,
    plan: 'studio',
    status,
    current_period_end: STRIPE_PAID_TO,
    stripe_subscription_id: 'sub_live',
    iap_original_transaction_id: 'otx_1',
  };
}

function appleEvent(db: FakeDb, notificationType: string, subtype?: string) {
  return createAppstoreWebhook(
    deps(db, {
      verifyNotification: () => Promise.resolve({ ...NOTIFICATION, notificationType, subtype }),
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.studio.monthly',
          transactionId: 'tx_old',
          originalTransactionId: 'otx_1',
          expiresDate: APPLE_ENDED,
          appAccountToken: TEST_USER,
        }),
    }),
  );
}

for (const [type, subtype] of [['EXPIRED', 'VOLUNTARY'], ['GRACE_PERIOD_EXPIRED', undefined]] as const) {
  Deno.test(`${type} after the user moved to Stripe leaves the Stripe-paid row alone`, async () => {
    const db = fakeDb();
    db.tables.subscriptions = [stripeCarriedRow()];
    assertEquals((await appleEvent(db, type, subtype)(post())).status, 200);
    assertEquals(db.tables.subscriptions[0].status, 'active');
    assertEquals(db.tables.subscriptions[0].current_period_end, STRIPE_PAID_TO);
  });
}

Deno.test('AUTO_RENEW_ENABLED on the old Apple plan does not un-cancel a Stripe row', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [stripeCarriedRow('canceled')];
  assertEquals((await appleEvent(db, 'DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED')(post())).status, 200);
  assertEquals(db.tables.subscriptions[0].status, 'canceled');
});

Deno.test('EXPIRED still ends a row Apple is paying for, even with an old Stripe id on it', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [{
    ...stripeCarriedRow(),
    current_period_end: new Date(APPLE_ENDED).toISOString(),
  }];
  assertEquals((await appleEvent(db, 'EXPIRED', 'VOLUNTARY')(post())).status, 200);
  assertEquals(db.tables.subscriptions[0].status, 'expired');
});

Deno.test('a late refund of an old Apple subscription neither expires the Stripe row nor zeroes its credits', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [stripeCarriedRow()];
  assertEquals((await appleEvent(db, 'REFUND')(post())).status, 200);
  assertEquals(db.tables.applied ?? [], [], 'no subscription_grant, no entitlement patch');
  assertEquals(db.tables.subscriptions[0].status, 'active');
  const finished = db.rpcCalls.find((c) => c.name === 'fn_finish_billing_delivery');
  assertEquals(finished?.args.p_error, null, 'the receipt closes as nothing owed');
});

Deno.test('a refund of the Apple subscription Apple is paying for still expires the row', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [{
    ...stripeCarriedRow(),
    stripe_subscription_id: null,
    current_period_end: new Date(APPLE_ENDED).toISOString(),
  }];
  assertEquals((await appleEvent(db, 'REFUND')(post())).status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals((db.tables.applied[0].p_entitlement as { status: string }).status, 'expired');
});
