import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from './testing/fakes.ts';
import { applyFulfillment, isDuplicateKey } from './billing-fulfillment.ts';

function db(): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_apply_fulfillment = () => ({
    applied: true,
    replay: false,
    reason: null,
    credits: { plan: 1500, pack: 0 },
    entitlement: 'studio',
  });
  return d;
}

Deno.test('maps the request onto the rpc argument names', async () => {
  const d = db();
  await applyFulfillment(d as never, {
    source: 'stripe',
    businessTxnId: 'in_1',
    userId: TEST_USER,
    kind: 'subscription_grant',
    plan: 'studio',
    credits: 1500,
    periodEnd: '2026-10-20T00:00:00.000Z',
    eventAt: '2026-09-20T00:00:00.000Z',
    entitlement: { plan: 'studio', status: 'active' },
    neverLower: true,
    clearPending: true,
  });
  assertEquals(d.rpcCalls[1].name, 'fn_apply_fulfillment');
  assertEquals(d.rpcCalls[1].args, {
    p_source: 'stripe',
    p_txn_id: 'in_1',
    p_user: TEST_USER,
    p_kind: 'subscription_grant',
    p_plan: 'studio',
    p_credits: 1500,
    p_period_end: '2026-10-20T00:00:00.000Z',
    p_event_at: '2026-09-20T00:00:00.000Z',
    p_entitlement: { plan: 'studio', status: 'active' },
    p_never_lower: true,
    p_clear_pending: true,
  });
});

Deno.test('returns the rpc result verbatim', async () => {
  const result = await applyFulfillment(db() as never, {
    source: 'stripe',
    businessTxnId: 'in_1',
    userId: TEST_USER,
    kind: 'subscription_grant',
    plan: 'studio',
    credits: 1500,
    eventAt: '2026-09-20T00:00:00.000Z',
  });
  assertEquals(result.applied, true);
  assertEquals(result.credits, { plan: 1500, pack: 0 });
});

Deno.test('an rpc error throws so the caller can answer 5xx', async () => {
  const d = db();
  d.failNext('rpc.fn_apply_fulfillment', 'deadlock detected', '40P01');
  await assertRejects(
    () =>
      applyFulfillment(d as never, {
        source: 'stripe',
        businessTxnId: 'in_1',
        userId: TEST_USER,
        kind: 'pack_grant',
        credits: 100,
        eventAt: '2026-09-20T00:00:00.000Z',
      }),
    Error,
    'deadlock detected',
  );
});

Deno.test('a missing result throws rather than reporting a phantom grant', async () => {
  const d = new FakeDb();
  d.rpcHandlers.fn_apply_fulfillment = () => null;
  await assertRejects(() =>
    applyFulfillment(d as never, {
      source: 'apple',
      businessTxnId: 'tx_1',
      userId: TEST_USER,
      kind: 'pack_grant',
      credits: 100,
      eventAt: '2026-09-20T00:00:00.000Z',
    })
  );
});

Deno.test('isDuplicateKey distinguishes 23505 from operational errors', () => {
  assertEquals(isDuplicateKey({ code: '23505' }), true);
  assertEquals(isDuplicateKey({ code: '40P01' }), false);
  assertEquals(isDuplicateKey({ code: '08006' }), false);
  assertEquals(isDuplicateKey({}), false);
  assertEquals(isDuplicateKey(null), false);
});

const receiptRequest = {
  source: 'stripe' as const, businessTxnId: 'in_receipt', userId: TEST_USER,
  kind: 'pack_grant' as const, credits: 100, eventAt: '2026-09-22T00:00:00.000Z',
};
Deno.test('verified failed fulfillment retains an unresolved receipt before the money call', async () => {
  const d = db();
  d.rpcHandlers.fn_record_billing_delivery = (args) => {
    d.tables.billing_deliveries = [{ ...args, resolved_at: null }];
    return null;
  };
  d.failNext('rpc.fn_apply_fulfillment', 'connection reset');
  await assertRejects(() => applyFulfillment(d as never, receiptRequest), Error, 'connection reset');
  assertEquals(d.tables.billing_deliveries?.length, 1);
  assertEquals(d.tables.billing_deliveries[0].resolved_at, null);
  assertEquals(d.rpcCalls.map(c => c.name), ['fn_record_billing_delivery', 'fn_apply_fulfillment', 'fn_finish_billing_delivery']);
  assertEquals(d.rpcCalls[2].args.p_error, 'connection reset');
});
Deno.test('receipt persistence failure prevents any credit transaction', async () => {
  const d = db();
  d.failNext('rpc.fn_record_billing_delivery', 'inbox unavailable');
  await assertRejects(() => applyFulfillment(d as never, receiptRequest), Error, 'inbox unavailable');
  assertEquals(d.rpcCalls.some(c => c.name === 'fn_apply_fulfillment'), false);
});
Deno.test('successful replay resolves its receipt only after fulfillment', async () => {
  const d = db();
  await applyFulfillment(d as never, receiptRequest);
  assertEquals(d.rpcCalls.map(c => c.name), ['fn_record_billing_delivery', 'fn_apply_fulfillment', 'fn_finish_billing_delivery']);
  assertEquals(d.rpcCalls[2].args.p_error, null);
});
