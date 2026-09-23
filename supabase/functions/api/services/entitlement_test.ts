import { assertEquals } from 'jsr:@std/assert';
import { isEntitled } from './entitlement.ts';

const NOW = Date.parse('2026-09-23T12:00:00Z');

Deno.test('active is entitled whatever the period end says', () => {
  assertEquals(isEntitled({ status: 'active', current_period_end: '2026-01-01T00:00:00Z' }, NOW), true);
  assertEquals(isEntitled({ status: 'active', current_period_end: null }, NOW), true);
});

Deno.test('canceled is entitled until the paid period ends', () => {
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-30T00:00:00Z' }, NOW), true);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-23T12:00:00Z' }, NOW), true);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: '2026-09-01T00:00:00Z' }, NOW), false);
  assertEquals(isEntitled({ status: 'canceled', current_period_end: null }, NOW), true);
});

Deno.test('expired or absent is not entitled', () => {
  assertEquals(isEntitled({ status: 'expired', current_period_end: '2099-01-01T00:00:00Z' }, NOW), false);
  assertEquals(isEntitled(null, NOW), false);
  assertEquals(isEntitled(undefined, NOW), false);
});
