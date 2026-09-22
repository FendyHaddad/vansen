import { assertStrictEquals } from 'jsr:@std/assert';
import { adapterFor } from './index.ts';
import { googleAdapter } from './google.ts';

Deno.test('persona generations go to Google', () => {
  assertStrictEquals(adapterFor('persona'), googleAdapter);
});
