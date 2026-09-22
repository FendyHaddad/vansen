// The rehearsal: a submission finishes with nobody watching.
//
// The gateway accepts and forgets; every later step is driven by an
// authenticated worker tick, which is what pg_cron calls once a minute. If
// this passes, closing the tab costs the customer nothing.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { createWorker } from '../job-worker/handler.ts';
import { installDispatchRpcs } from './_shared/testing/worker.ts';
import { finishJob } from './_shared/jobs/store.ts';
import { resolvePayload } from './_shared/jobs/payload.ts';
import type { ClaimedJob } from './_shared/jobs/lease.ts';
import type { CheckResult, ProviderAdapter } from './_shared/providers/types.ts';
import type { StorageAdapter } from './_shared/storage/index.ts';

const AUTH = { authorization: 'Bearer test-token' };
const SECRET = 'worker-secret';

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.notification_outbox = [];
  installDispatchRpcs(db);
  db.rpcHandlers.fn_claim_notifications = () => [];
  db.rpcHandlers.fn_settle_job = (args, self) => {
    const job = (self.tables.jobs ?? []).find((j) => j.id === args.p_job);
    const gen = (self.tables.generations ?? []).find((g) => g.id === job?.generation_id);
    if (!gen || gen.status !== 'pending') {
      return { settled: false, previous: gen?.status ?? null, refunded: 0 };
    }
    gen.status = args.p_outcome === 'done' ? 'done' : 'failed';
    if (args.p_outcome === 'done') gen.media_path = args.p_media_path;
    return { settled: true, previous: 'pending', refunded: 0 };
  };
}

function storage(db: FakeDb): StorageAdapter {
  return {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      await db.storage.from('media').upload(key, bytes, { contentType });
    },
    delete: async (key: string) => {
      await db.storage.from('media').remove([key]);
    },
    signedUrl: (key: string) => Promise.resolve(`https://fake.media/${key}`),
  } as unknown as StorageAdapter;
}

function worker(db: FakeDb, adapter: ProviderAdapter) {
  const admin = db as unknown as Parameters<typeof finishJob>[0]['admin'];
  return createWorker({
    admin,
    workerSecret: SECRET,
    jobs: {
      adapterFor: () => adapter,
      resolvePayload: (job: ClaimedJob) =>
        resolvePayload({ admin, storageFor: () => storage(db) }, job),
      finish: (job: ClaimedJob, result: CheckResult) =>
        finishJob({ admin, storageFor: () => storage(db) }, {
          id: job.id,
          user_id: job.user_id,
          generation_id: job.generation_id,
          attempts: job.poll_attempts,
          lease_token: job.lease_token,
        }, result),
      reconcile: () => Promise.resolve('pending' as const),
    },
    notifications: { account: null, sendPush: () => Promise.resolve([]) },
  });
}

function tick(run: ReturnType<typeof worker>): Promise<Response> {
  return run(
    new Request('http://worker/', { method: 'POST', headers: { 'x-worker-secret': SECRET } }),
  );
}

function submitBody() {
  return JSON.stringify({
    op: 'generate',
    familyId: 'flux',
    prompt: 'a cat',
    batch: 1,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
  });
}

Deno.test('a submitted job reaches done with media, driven only by the worker', async () => {
  const provider = fakeAdapter({
    check: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const accepted = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: submitBody(),
  });
  assertEquals(accepted.status, 202);
  // From here on no client exists: only ticks.
  await tick(worker(db, provider.adapter));
  await tick(worker(db, provider.adapter));

  assertEquals(db.tables.generations[0].status, 'done');
  assertEquals([...db.storage.objects.keys()].some((k) => k.startsWith('media/')), true);
  assertEquals(provider.submits.length, 1);
  assertEquals(db.tables.jobs[0].state, 'done');
});

Deno.test('a worker that dies mid-flight is replaced, and the job is submitted once', async () => {
  const provider = fakeAdapter({
    check: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: submitBody(),
  });

  await tick(worker(db, provider.adapter));
  // The worker vanished after submitting: the lease is abandoned, exactly as
  // fn_expire_leases would leave it.
  db.tables.jobs[0].lease_token = null;
  db.tables.jobs[0].lease_until = null;
  await tick(worker(db, provider.adapter));
  await tick(worker(db, provider.adapter));

  assertEquals(provider.submits.length, 1, 'a replacement worker must not resubmit paid work');
  assertEquals(db.tables.generations[0].status, 'done');
});

Deno.test('a crash BETWEEN the call and the record is never resubmitted on a guess', async () => {
  const provider = fakeAdapter({
    check: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: submitBody(),
  });

  // The worst case: we said "submitting", the provider may or may not have it,
  // and the process died before the reference was written.
  db.tables.jobs[0].state = 'submitting';
  db.tables.jobs[0].provider_ref = null;
  db.tables.jobs[0].lease_token = null;
  db.tables.jobs[0].lease_until = null;
  await tick(worker(db, provider.adapter));
  await tick(worker(db, provider.adapter));

  assertEquals(provider.submits.length, 0, 'an unknown submit must not be repeated');
  // Held for reconciliation, not refunded: nobody has said the work failed.
  assertEquals(db.tables.jobs[0].state, 'reconciling');
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('a tick without the worker secret advances nothing', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: submitBody(),
  });

  const res = await worker(db, provider.adapter)(
    new Request('http://worker/', { method: 'POST' }),
  );

  assertEquals(res.status, 401);
  assertEquals(provider.submits.length, 0);
  assertEquals(db.tables.jobs[0].state, 'ready');
});
