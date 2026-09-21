import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb } from '../testing/fakes.ts';
import { settleDone, settleFailed } from './settlement.ts';

function db(result: Record<string, unknown>): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_settle_job = (args, self) => {
    self.tables.settled ??= [];
    self.tables.settled.push({ ...args });
    return result;
  };
  return d;
}

Deno.test('settleDone passes the media path and backend', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 0 });
  const out = await settleDone(d as never, 'job-1', {
    path: 'u/g.mp4',
    backend: 'r2',
    meta: { durationS: 8, width: 1920, height: 1080 },
  });
  assertEquals(out, { settled: true, previous: 'pending', refunded: 0 });
  assertEquals(d.tables.settled[0], {
    p_job: 'job-1',
    p_outcome: 'done',
    p_media_path: 'u/g.mp4',
    p_backend: 'r2',
    p_meta: { durationS: 8, width: 1920, height: 1080 },
    p_error: null,
    p_expected_state: 'pending',
    p_lease_token: null,
  });
});

Deno.test('settleFailed reports what was refunded', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 40 });
  assertEquals(await settleFailed(d as never, 'job-1', 'cancelled'), {
    settled: true,
    previous: 'pending',
    refunded: 40,
  });
});

Deno.test('a cancel is labelled as one, so the customer is not told it failed', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 40 });
  await settleFailed(d as never, 'job-1', 'cancelled');
  assertEquals(d.tables.settled[0].p_failure_code, 'cancelled');
});

Deno.test('losing the race reports the winner, not an error', async () => {
  const d = db({ settled: false, previous: 'done', refunded: 0 });
  const out = await settleFailed(d as never, 'job-1', 'timeout');
  assertEquals(out.settled, false);
  assertEquals(out.previous, 'done');
});

Deno.test('an rpc error throws — an unknown settlement is never assumed done', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 0 });
  d.failNext('rpc.fn_settle_job', 'connection reset', '08006');
  await assertRejects(
    () => settleDone(d as never, 'job-1', { path: 'u/g.png', backend: 'supabase' }),
    Error,
    'connection reset',
  );
});

Deno.test('a null rpc result throws rather than reporting a phantom settlement', async () => {
  const d = new FakeDb();
  d.rpcHandlers.fn_settle_job = () => null;
  await assertRejects(() => settleFailed(d as never, 'job-1', 'x'));
});
