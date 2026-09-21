// Settlement, from the route the customer called to the tick that finished it.
//
// Before P5 every one of these happened inside the POST or the GET that the
// client was holding open. They now happen in the worker, so each test submits
// through the gateway and then runs one tick: the assertions are the same
// money rules, proven where the money now moves.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { runWorkerTick } from './_shared/testing/worker.ts';
import { finishJob } from './_shared/jobs/store.ts';
import type { ClaimedJob } from './_shared/jobs/lease.ts';
import type { CheckResult } from './_shared/providers/types.ts';
import type { StorageAdapter } from './_shared/storage/index.ts';

const AUTH = { authorization: 'Bearer test-token' };

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [
    { id: 'flux', enabled: true, min_plan: 'studio' },
    { id: 'kling', enabled: true, min_plan: 'pro' },
  ];
  db.tables.notification_outbox = [];
  // Keyed by job, as the real one is: the route no longer knows a generation
  // id when it asks for a settlement.
  db.rpcHandlers.fn_settle_job = (args, self) => {
    const job = (self.tables.jobs ?? []).find((j) => j.id === args.p_job);
    const target = (self.tables.generations ?? []).find((g) => g.id === job?.generation_id);
    if (!target || target.status !== 'pending') {
      return { settled: false, previous: target?.status ?? null, refunded: 0 };
    }
    if (args.p_outcome === 'done') {
      target.status = 'done';
      target.media_path = args.p_media_path;
      return { settled: true, previous: 'pending', refunded: 0 };
    }
    target.status = 'failed';
    return { settled: true, previous: 'pending', refunded: Number(target.charged_plan ?? 0) };
  };
}

/** The real finisher, writing into FakeStorage (images go via the media bucket). */
function finisher(db: FakeDb, storage?: Partial<StorageAdapter>) {
  const adapter = {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      const { error } = await db.storage.from('media').upload(key, bytes, { contentType });
      if (error) throw new Error(error.message);
    },
    delete: async (key: string) => {
      await db.storage.from('media').remove([key]);
    },
    signedUrl: (key: string) => Promise.resolve(`https://fake.media/${key}`),
    ...storage,
  } as unknown as StorageAdapter;
  return (job: ClaimedJob, result: CheckResult) =>
    finishJob(
      { admin: db as unknown as Parameters<typeof finishJob>[0]['admin'], storageFor: () => adapter },
      {
        id: job.id,
        user_id: job.user_id,
        generation_id: job.generation_id,
        attempts: job.poll_attempts,
        lease_token: job.lease_token,
      },
      result,
    );
}

function body(familyId = 'flux') {
  const settings = familyId === 'kling'
    ? { aspectRatio: '16:9', mode: 't2v', durationS: 5, audio: 'off' }
    : { aspectRatio: '1:1', resolution: '1MP' };
  return JSON.stringify({ op: 'generate', familyId, prompt: 'a cat', batch: 1, settings });
}

async function submit(db: FakeDb, deps: Parameters<typeof createApp>[0], familyId = 'flux') {
  ready(db);
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: body(familyId),
  });
  assertEquals(res.status, 202);
  return app;
}

const inlineDone = () =>
  Promise.resolve({
    providerRef: 'inline',
    inline: {
      state: 'done' as const,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    },
  });

Deno.test('R05: a failed media upload must NOT produce a done generation', async () => {
  const provider = fakeAdapter({ submit: inlineDone });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);

  db.storage.failNext('media.upload', 'storage unavailable');
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  const stored = db.tables.generations.find((g) => g.id === 'g0');
  assertEquals(stored?.status === 'done', false, 'a generation with no stored media is not done');
  assertEquals(stored?.status, 'failed');
});

Deno.test('R05: a failed upload refunds the charge', async () => {
  const provider = fakeAdapter({ submit: inlineDone });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);

  db.storage.failNext('media.upload', 'storage unavailable');
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  const settle = db.rpcCalls.filter((r) => r.name === 'fn_settle_job');
  assertEquals(settle.length, 1);
  assertEquals(settle[0].args.p_outcome, 'failed');
});

Deno.test('a successful tick stores the object and settles done', async () => {
  const provider = fakeAdapter({ submit: inlineDone });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(db.tables.generations.find((g) => g.id === 'g0')?.status, 'done');
  assertEquals([...db.storage.objects.keys()].some((k) => k.startsWith('media/')), true);
  // The job is finished too, so the next tick will not pick it up again.
  assertEquals(db.tables.jobs[0].state, 'done');
});

Deno.test('R08: a retryable provider failure does NOT refund', async () => {
  const provider = fakeAdapter({ check: { state: 'retryable_failure', error: 'fal status 429' } });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
  assertEquals(db.tables.jobs[0].state, 'submitted');
});

Deno.test('R08: a thrown provider check does NOT refund either', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });
  provider.adapter.check = () => Promise.reject(new TypeError('error sending request for url'));

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('R08: a TERMINAL provider failure does refund', async () => {
  const provider = fakeAdapter({ check: { state: 'failed', error: 'content filtered' } });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  const settle = db.rpcCalls.filter((r) => r.name === 'fn_settle_job');
  assertEquals(settle.length, 1);
  assertEquals(settle[0].args.p_outcome, 'failed');
  assertEquals(db.tables.generations[0].status, 'failed');
});

Deno.test('R08: a cancel the provider never received does NOT refund', async () => {
  const provider = fakeAdapter({ cancel: 'unreachable' });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  const app = await submit(db, deps, 'kling');
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  // The request is durable: 202, no refund promised, no provider call here.
  const res = await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 202);
  assertEquals((await res.json()).refundedCredits, 0);
  assertEquals(provider.cancels.length, 0);

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(provider.cancels.length, 1);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('R08: a cancel the provider accepted DOES refund', async () => {
  const provider = fakeAdapter({ cancel: 'cancelled' });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  const app = await submit(db, deps, 'kling');
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  const settle = db.rpcCalls.filter((r) => r.name === 'fn_settle_job');
  assertEquals(settle.length, 1);
  assertEquals(settle[0].args.p_outcome, 'failed');
  assertEquals(db.tables.generations[0].status, 'failed');
});

Deno.test('R08: a job already rendering does NOT refund on cancel', async () => {
  const provider = fakeAdapter({ cancel: 'too_late' });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  const app = await submit(db, deps, 'kling');
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('a cancel before dispatch refunds without asking any provider', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  const app = await submit(db, deps, 'kling');

  await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });
  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals(provider.submits.length, 0);
  assertEquals(provider.cancels.length, 0);
  assertEquals(db.tables.generations[0].status, 'failed');
});

Deno.test('losing the settlement race drops the object instead of overwriting the winner', async () => {
  const provider = fakeAdapter({ submit: inlineDone });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await submit(db, deps);
  db.rpcHandlers.fn_settle_job = () => ({ settled: false, previous: 'failed', refunded: 40 });

  await runWorkerTick(db, { adapterFor: () => provider.adapter, finish: finisher(db) });

  assertEquals([...db.storage.objects.keys()].filter((k) => k.startsWith('media/')), []);
});
