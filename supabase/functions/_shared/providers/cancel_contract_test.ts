import { assertEquals } from 'jsr:@std/assert';
import { falAdapter } from './fal.ts';
import { runwayAdapter } from './runway.ts';
import { captureFetch } from './testing/capture.ts';

const REF = JSON.stringify({
  statusUrl: 'https://queue.fal.run/fal-ai/model/requests/req_1/status',
  responseUrl: 'https://queue.fal.run/fal-ai/model/requests/req_1',
});

function statusIs(state: string) {
  return (call: { url: string }) =>
    call.url.endsWith('/status')
      ? new Response(JSON.stringify({ status: state }), { status: 200 })
      : new Response(null, { status: 200 });
}

Deno.test('fal: cancelling a QUEUED request succeeds', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(statusIs('IN_QUEUE'));
  assertEquals(await falAdapter.cancel!(REF), 'cancelled');
  cap.restore();
});

Deno.test('fal: a request already IN_PROGRESS reports too_late, never cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(statusIs('IN_PROGRESS'));
  assertEquals(await falAdapter.cancel!(REF), 'too_late');
  cap.restore();
});

Deno.test('fal: an unreachable provider reports unreachable, so no refund follows', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => {
    throw new TypeError('error sending request for url');
  });
  assertEquals(await falAdapter.cancel!(REF), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 while cancelling is unreachable, not cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  assertEquals(await falAdapter.cancel!(REF), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 on check is retryable, not failed', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  const result = await falAdapter.check(REF);
  assertEquals(result.state, 'retryable_failure');
  cap.restore();
});

Deno.test('fal: a retry-after header is honoured and capped', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() =>
    new Response('slow down', { status: 429, headers: { 'retry-after': '99999' } })
  );
  const result = await falAdapter.check(REF);
  assertEquals(result.state === 'retryable_failure' ? result.retryAfterSeconds : null, 300);
  cap.restore();
});

Deno.test('fal: a 400 on check is a real failure', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('bad request', { status: 400 }));
  const result = await falAdapter.check(REF);
  assertEquals(result.state, 'failed');
  cap.restore();
});

Deno.test('fal: a finished image is handed to the bounded shared store', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) {
      return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
    }
    if (call.url.includes('queue.fal.run')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal/out.png' }] }), {
        status: 200,
      });
    }
    return new Response('gateway timeout', { status: 504 });
  });
  const result = await falAdapter.check(REF);
  assertEquals(result.state, 'done');
  assertEquals('url' in result ? result.url : null, 'https://cdn.fal/out.png');
  cap.restore();
});

Deno.test('fal: a malformed provider ref is terminal, not retried forever', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const result = await falAdapter.check('not json');
  assertEquals(result.state, 'failed');
});

Deno.test('runway: cancel reports an outcome for every status', async () => {
  Deno.env.set('RUNWAY_API_KEY', 'test-key');
  const ok = captureFetch(() => new Response(null, { status: 204 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'cancelled');
  ok.restore();

  const late = captureFetch(() => new Response('already complete', { status: 409 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'too_late');
  late.restore();

  const down = captureFetch(() => new Response('bad gateway', { status: 502 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'unreachable');
  down.restore();
});

Deno.test('runway: a 429 on check is retryable, a 400 is failed', async () => {
  Deno.env.set('RUNWAY_API_KEY', 'test-key');
  const busy = captureFetch(() => new Response('slow down', { status: 429 }));
  assertEquals((await runwayAdapter.check('task_1')).state, 'retryable_failure');
  busy.restore();

  const bad = captureFetch(() => new Response('bad request', { status: 400 }));
  assertEquals((await runwayAdapter.check('task_1')).state, 'failed');
  bad.restore();
});
