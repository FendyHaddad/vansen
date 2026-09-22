import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
for (const [path, bucket] of [['/generations','generation'], ['/generations/g1/retry','generation'], ['/uploads','upload'], ['/edits/save','upload']]) {
  Deno.test(`rate limit ${path} refuses before parsing or doing paid work`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    db.rpcHandlers.fn_take_request_slot = () => ({ allowed: false, retryAfterSeconds: 42 });
    const res = await createApp(deps).request(`/api${path}`, { method: 'POST', headers: AUTH, body: '{bad-json' });
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('retry-after'), '42');
    assertEquals((await res.json()).error.code, 'rate_limited');
    assertEquals(db.rpcCalls.find(c => c.name === 'fn_take_request_slot')?.args, { p_user: TEST_USER, p_bucket: bucket });
    assertEquals(db.rpcCalls.some(c => c.name === 'fn_reserve_generation'), false);
    assertEquals(db.storage.objects.size, 0);
  });
}
Deno.test('rate limiter database outage fails closed before request work', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.failNext('rpc.fn_take_request_slot', 'database unavailable');
  const res = await createApp(deps).request('/api/uploads', { method: 'POST', headers: AUTH, body: '{}' });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'request_limit_unavailable');
});
