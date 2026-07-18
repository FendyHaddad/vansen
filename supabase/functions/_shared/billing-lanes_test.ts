import { assertEquals } from 'jsr:@std/assert';
import { laneFor } from './billing-lanes.ts';

Deno.test('android is lane A on every storefront', () => {
  assertEquals(laneFor('android', 'US'), 'A');
  assertEquals(laneFor('android', 'MY'), 'A');
  assertEquals(laneFor('android', ''), 'A');
});

Deno.test('ios US and EU storefronts are lane A', () => {
  assertEquals(laneFor('ios', 'US'), 'A');
  assertEquals(laneFor('ios', 'DE'), 'A');
  assertEquals(laneFor('ios', 'FR'), 'A');
  assertEquals(laneFor('ios', 'SE'), 'A');
});

Deno.test('other ios storefronts fall back to lane C', () => {
  assertEquals(laneFor('ios', 'MY'), 'C');
  assertEquals(laneFor('ios', 'GB'), 'C');
  assertEquals(laneFor('ios', 'JP'), 'C');
  assertEquals(laneFor('ios', ''), 'C');
});

Deno.test('lane B flag flips rest-of-world iOS from C to B', () => {
  assertEquals(laneFor('ios', 'MY', true), 'B');
  assertEquals(laneFor('ios', 'JP', true), 'B');
  assertEquals(laneFor('ios', 'MY', false), 'C');
  assertEquals(laneFor('ios', 'US', true), 'A');
  assertEquals(laneFor('android', 'MY', true), 'A');
});
