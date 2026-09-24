import { assertEquals } from 'jsr:@std/assert';
import { ENTITLEMENT_GRACE_MS, isEntitled } from './entitlement.ts';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

Deno.test('the grace for late renewal webhooks is three days', () => {
  assertEquals(ENTITLEMENT_GRACE_MS, 3 * DAY);
});

Deno.test('active inside the paid period or the 3-day grace is entitled (Stripe behaviour unchanged)', () => {
  assertEquals(isEntitled({ status: 'active', current_period_end: at(30 * DAY) }, NOW), true);
  assertEquals(isEntitled({ status: 'active', current_period_end: at(0) }, NOW), true);
  // A renewal invoice.paid that lands a day or two late must not cut access.
  assertEquals(isEntitled({ status: 'active', current_period_end: at(-1 * DAY) }, NOW), true);
  assertEquals(isEntitled({ status: 'active', current_period_end: at(-2 * DAY) }, NOW), true);
  assertEquals(isEntitled({ status: 'active', current_period_end: null }, NOW), true);
});

Deno.test('active: the grace boundary is exclusive — later than now minus 3 days', () => {
  assertEquals(isEntitled({ status: 'active', current_period_end: at(-3 * DAY + 1) }, NOW), true);
  assertEquals(isEntitled({ status: 'active', current_period_end: at(-3 * DAY) }, NOW), false);
  assertEquals(isEntitled({ status: 'active', current_period_end: at(-3 * DAY - 1) }, NOW), false);
});

Deno.test('active with a period long gone (a missed App Store EXPIRED) is not entitled', () => {
  assertEquals(isEntitled({ status: 'active', current_period_end: '2026-01-01T00:00:00Z' }, NOW), false);
});

Deno.test('canceled is entitled until the paid period ends — no grace added', () => {
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-30T00:00:00Z' }, NOW), true);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-23T12:00:00Z' }, NOW), true);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: at(-1) }, NOW), false);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: at(-1 * DAY) }, NOW), false);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-01T00:00:00Z' }, NOW), false);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: null }, NOW), true);
});

Deno.test('expired or absent is not entitled', () => {
  assertEquals(isEntitled({ status: 'expired', current_period_end: '2099-01-01T00:00:00Z' }, NOW), false);
  assertEquals(isEntitled(null, NOW), false);
  assertEquals(isEntitled(undefined, NOW), false);
});
