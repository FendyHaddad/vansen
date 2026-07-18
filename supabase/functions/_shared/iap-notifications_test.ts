import { assertEquals } from 'jsr:@std/assert';
import { actionFor } from './iap-notifications.ts';

Deno.test('purchases and renewals grant a cycle', () => {
  assertEquals(actionFor('SUBSCRIBED', 'INITIAL_BUY'), 'cycle_grant');
  assertEquals(actionFor('SUBSCRIBED', 'RESUBSCRIBE'), 'cycle_grant');
  assertEquals(actionFor('DID_RENEW'), 'cycle_grant');
});

Deno.test('renewal-status toggles map to canceled/active', () => {
  assertEquals(actionFor('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED'), 'set_canceled');
  assertEquals(actionFor('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED'), 'set_active');
});

Deno.test('expiry paths set expired', () => {
  assertEquals(actionFor('EXPIRED'), 'set_expired');
  assertEquals(actionFor('GRACE_PERIOD_EXPIRED'), 'set_expired');
});

Deno.test('consumables grant packs and refunds claw back', () => {
  assertEquals(actionFor('ONE_TIME_CHARGE'), 'pack_grant');
  assertEquals(actionFor('REFUND'), 'refund');
});

Deno.test('everything else is ignored', () => {
  assertEquals(actionFor('TEST'), 'ignore');
  assertEquals(actionFor('PRICE_INCREASE', 'PENDING'), 'ignore');
  assertEquals(actionFor('DID_CHANGE_RENEWAL_STATUS'), 'ignore');
});
