import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { bodyHash, canonicalJson } from './idempotency.ts';

Deno.test('key order does not change the canonical form', () => {
  assertEquals(
    canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }),
    canonicalJson({ a: 2, c: { y: 2, z: 1 }, b: 1 }),
  );
});

Deno.test('undefined members are dropped, null members are kept', () => {
  assertEquals(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assertNotEquals(canonicalJson({ a: 1, b: null }), canonicalJson({ a: 1 }));
});

Deno.test('array order IS significant — reference slots are ordered', () => {
  assertNotEquals(canonicalJson({ refs: ['a', 'b'] }), canonicalJson({ refs: ['b', 'a'] }));
});

Deno.test('the same request hashes the same', async () => {
  const a = await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 1 });
  const b = await bodyHash({ batch: 1, prompt: 'a cat', familyId: 'flux' });
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

Deno.test('a different prompt hashes differently', async () => {
  const a = await bodyHash({ familyId: 'flux', prompt: 'a cat' });
  const b = await bodyHash({ familyId: 'flux', prompt: 'a dog' });
  assertNotEquals(a, b);
});

Deno.test('a different batch size hashes differently', async () => {
  assertNotEquals(
    await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 1 }),
    await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 4 }),
  );
});
