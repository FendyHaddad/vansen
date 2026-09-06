import { assertEquals } from 'jsr:@std/assert';
import { familyById } from './model-families.ts';
import { dailyCapState, expectedSecondsFor, referenceRule, videoJobCapReached } from './video-rules.ts';

Deno.test('referenceRule per mode', () => {
  assertEquals(referenceRule('t2v'), { min: 0, max: 0, needsParent: false });
  assertEquals(referenceRule('i2v'), { min: 1, max: 1, needsParent: false });
  assertEquals(referenceRule('ref2v'), { min: 1, max: 3, needsParent: false });
  assertEquals(referenceRule('keyframes'), { min: 2, max: 2, needsParent: false });
  assertEquals(referenceRule('extend'), { min: 0, max: 0, needsParent: true });
  assertEquals(referenceRule('edit'), { min: 0, max: 0, needsParent: true });
});

Deno.test('videoJobCapReached at 3', () => {
  assertEquals(videoJobCapReached(2), false);
  assertEquals(videoJobCapReached(3), true);
});

Deno.test('dailyCapState blocks at $40 and reports reset 24 h after oldest charge', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const oldest = new Date('2026-09-05T15:30:00Z');
  assertEquals(dailyCapState(12.5, oldest, now), { blocked: false, resetsAt: null });
  assertEquals(dailyCapState(40, oldest, now), { blocked: true, resetsAt: '2026-09-06T15:30:00.000Z' });
  assertEquals(dailyCapState(41, null, now), { blocked: true, resetsAt: '2026-09-07T12:00:00.000Z' });
});

Deno.test('expectedSecondsFor = expectedSPerS × duration', () => {
  assertEquals(expectedSecondsFor(familyById('veo')!, 8), 96);
  assertEquals(expectedSecondsFor(familyById('kling')!, undefined), 100);
  assertEquals(expectedSecondsFor(familyById('flux')!, 5), 30);
});
