import { assertEquals } from 'jsr:@std/assert';
import { moderate } from './moderation.ts';

const realFetch = globalThis.fetch;
const realKey = Deno.env.get('OPENAI_API_KEY');

function restore() {
  globalThis.fetch = realFetch;
  if (realKey === undefined) Deno.env.delete('OPENAI_API_KEY');
  if (realKey !== undefined) Deno.env.set('OPENAI_API_KEY', realKey);
}

Deno.test('missing key is unavailable, never allowed', async () => {
  Deno.env.delete('OPENAI_API_KEY');
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('non-OK http is unavailable', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.resolve(new Response('', { status: 503 }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('429 reports the provider retry-after', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision, { state: 'unavailable', reason: 'moderation_http_429', retryAfterSeconds: 30 });
  restore();
});

Deno.test('network throw is unavailable', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.reject(new Error('econnreset'));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('malformed body is unavailable, not allowed', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('flagged content is blocked with its categories', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ results: [{ flagged: true, category_scores: { violence: 0.9 } }] }),
        { status: 200 },
      ),
    );
  const decision = await moderate({ text: 'bad' });
  assertEquals(decision, { state: 'blocked', categories: { violence: 0.9 } });
  restore();
});

Deno.test('clean content is allowed', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ results: [{ flagged: false, category_scores: {} }] }), { status: 200 }),
    );
  assertEquals(await moderate({ text: 'a cat' }), { state: 'allowed' });
  restore();
});

Deno.test('genuinely empty input is allowed without calling the api', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  assertEquals(await moderate({}), { state: 'allowed' });
  assertEquals(called, false);
  restore();
});
