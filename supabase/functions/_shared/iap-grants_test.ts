import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { clawBackIap } from './iap-grants.ts';
import { FakeDb, TEST_USER, OTHER_USER } from './testing/fakes.ts';

const tx = { productId: 'pack', transactionId: 'tx_old', originalTransactionId: 'tx_old' };
for (const prefix of ['iap', 'apple']) {
  Deno.test(`refund finds the original ${prefix} grant and claws back its exact amount`, async () => {
    const db = new FakeDb();
    db.tables.ledger_entries = [{ stripe_ref: `${prefix}:tx_old`, user_id: TEST_USER, amount_credits: 1234 }];
    db.rpcHandlers.fn_apply_fulfillment = () => ({ applied: true, replay: false });
    await clawBackIap(db as never, TEST_USER, tx);
    const calls = db.rpcCalls.filter(c => c.name === 'fn_apply_fulfillment');
    assertEquals(calls.length, 1);
    assertEquals(calls[0].args.p_credits, 1234);
    assertEquals(calls[0].args.p_txn_id, 'refund:tx_old');
  });
}
Deno.test('refund lookup outage throws so the webhook retries', async () => {
  const db = new FakeDb();
  db.failNext('ledger_entries.select', 'database unavailable');
  await assertRejects(() => clawBackIap(db as never, TEST_USER, tx), Error, 'database unavailable');
});
Deno.test('refund does not claw back another account grant', async () => {
  const db = new FakeDb();
  db.tables.ledger_entries = [{ stripe_ref: 'apple:tx_old', user_id: OTHER_USER, amount_credits: 1234 }];
  await clawBackIap(db as never, TEST_USER, tx);
  assertEquals(db.rpcCalls.length, 0);
});
