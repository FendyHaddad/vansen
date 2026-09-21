import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, type Row } from '../testing/fakes.ts';
import { type ClaimedJob } from './lease.ts';
import { type JobDeps, type ReconcileResult, runJob } from './dispatch.ts';
import type { CheckResult, ProviderAdapter, SubmitCtx } from '../providers/types.ts';

const USER = 'u0';

interface Harness {
  db: FakeDb;
  deps: JobDeps;
  submits: SubmitCtx[];
  checks: string[];
  cancels: string[];
  finished: CheckResult[];
  job: ClaimedJob;
}

function harness(opts: {
  state?: ClaimedJob['state'];
  providerRef?: string | null;
  cancelRequested?: boolean;
  submit?: () => Promise<{ providerRef: string; inline?: CheckResult }>;
  check?: () => Promise<CheckResult>;
  cancel?: () => Promise<'cancelled' | 'too_late' | 'unsupported' | 'unreachable'>;
  resolve?: () => Promise<SubmitCtx>;
  reconcile?: () => Promise<ReconcileResult>;
  /** What P4's finisher would do to the generation. */
  finish?: (db: FakeDb, result: CheckResult) => void;
} = {}): Harness {
  const db = new FakeDb();
  const state = opts.state ?? 'ready';
  db.tables.generations = [
    { id: 'g0', user_id: USER, kind: 'image', family_id: 'flux', status: 'pending', charged_plan: 40, charged_pack: 0, media_path: null },
  ];
  db.tables.jobs = [{
    id: 'j0', user_id: USER, generation_id: 'g0', provider: 'fal', state,
    provider_ref: opts.providerRef ?? null, lease_token: 'lease-1',
    lease_until: '2099-01-01T00:00:00Z', submit_attempts: 0, poll_attempts: 0,
    next_run_at: '2026-09-21T00:00:00Z', dispatch_key: 'dk-1', payload: {},
    cancel_requested_at: opts.cancelRequested ? '2026-09-21T00:00:00Z' : null,
  }];
  wireLeaseRpcs(db);

  const submits: SubmitCtx[] = [];
  const checks: string[] = [];
  const cancels: string[] = [];
  const finished: CheckResult[] = [];
  const adapter: ProviderAdapter = {
    provider: 'fal',
    submit: (ctx) => {
      submits.push(ctx);
      if (opts.submit) return opts.submit();
      return Promise.resolve({ providerRef: 'req_1' });
    },
    check: (ref) => {
      checks.push(ref);
      if (opts.check) return opts.check();
      return Promise.resolve({ state: 'running' } as CheckResult);
    },
    cancel: (ref) => {
      cancels.push(ref);
      if (opts.cancel) return opts.cancel();
      return Promise.resolve('cancelled');
    },
  };

  const job: ClaimedJob = {
    id: 'j0', user_id: USER, generation_id: 'g0', family_id: 'flux', kind: 'image',
    state, provider_ref: opts.providerRef ?? null, dispatch_key: 'dk-1',
    lease_token: 'lease-1', lease_until: '2099-01-01T00:00:00Z', payload: {},
    submit_attempts: 0, poll_attempts: 0,
    cancel_requested_at: opts.cancelRequested ? '2026-09-21T00:00:00Z' : null,
  };

  return {
    db,
    submits,
    checks,
    cancels,
    finished,
    job,
    deps: {
      admin: db as unknown as SupabaseClient,
      adapterFor: () => adapter,
      resolvePayload: opts.resolve ??
        (() => Promise.resolve({ familyId: 'flux', op: 'generate', prompt: 'a cat', settings: {}, safetyId: 's' })),
      finish: (_job, result) => {
        finished.push(result);
        opts.finish?.(db, result);
        return Promise.resolve();
      },
      reconcile: opts.reconcile ?? (() => Promise.resolve('pending' as ReconcileResult)),
    },
  };
}

/** The lease RPCs, behaving exactly as 0020 defines them. */
function wireLeaseRpcs(db: FakeDb): void {
  const held = (args: Row): Row | null => {
    const job = (db.tables.jobs ?? []).find((j) => j.id === args.p_job);
    if (!job) return null;
    if (job.lease_token !== args.p_token) return null;
    if (String(job.lease_until) <= new Date().toISOString()) return null;
    return job;
  };
  db.rpcHandlers.fn_begin_submit = (args) => {
    const job = held(args);
    if (!job || job.state !== 'ready') return false;
    job.state = 'submitting';
    job.submit_attempts = Number(job.submit_attempts) + 1;
    return true;
  };
  db.rpcHandlers.fn_record_provider_ref = (args) => {
    const job = held(args);
    if (!job) return false;
    job.provider_ref = args.p_ref;
    return true;
  };
  db.rpcHandlers.fn_count_poll = (args) => {
    const job = held(args);
    if (!job) return false;
    job.poll_attempts = Number(job.poll_attempts) + 1;
    return true;
  };
  db.rpcHandlers.fn_release_job = (args) => {
    const job = held(args);
    if (!job) return false;
    job.state = args.p_state;
    job.provider_ref = args.p_provider_ref ?? job.provider_ref;
    job.last_error = args.p_error;
    job.lease_token = null;
    job.lease_until = null;
    job.next_run_at = new Date(Date.now() + Number(args.p_delay_seconds ?? 0) * 1000).toISOString();
    return true;
  };
  db.rpcHandlers.fn_settle_job = (args) => {
    const job = (db.tables.jobs ?? []).find((j) => j.id === args.p_job);
    const gen = (db.tables.generations ?? []).find((g) => g.id === job?.generation_id);
    if (!job || !gen) return { settled: false, previous: null, refunded: 0 };
    const leased = job.lease_token !== null || args.p_lease_token !== null;
    const matches = job.lease_token === args.p_lease_token &&
      String(job.lease_until ?? '') > new Date().toISOString();
    if (leased && !matches) return { settled: false, previous: gen.status, refunded: 0 };
    if (gen.status !== 'pending') return { settled: false, previous: gen.status, refunded: 0 };
    gen.status = args.p_outcome === 'done' ? 'done' : 'failed';
    gen.media_path = args.p_media_path ?? gen.media_path;
    job.state = 'done';
    job.lease_token = null;
    job.lease_until = null;
    return {
      settled: true,
      previous: 'pending',
      refunded: args.p_outcome === 'done' ? 0 : Number(gen.charged_plan ?? 0),
    };
  };
}

function job(h: Harness): Row {
  return h.db.tables.jobs[0];
}

Deno.test('a ready job is submitted exactly once and waits to be polled', async () => {
  const h = harness();
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 1);
  assertEquals(job(h).state, 'submitted');
  assertEquals(job(h).provider_ref, 'req_1');
  assertEquals(job(h).submit_attempts, 1);
});

Deno.test('a submitted job polls and never submits again', async () => {
  const h = harness({ state: 'submitted', providerRef: 'req_1' });
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0, 'polling must not re-submit paid work');
  assertEquals(h.checks, ['req_1']);
  assertEquals(job(h).state, 'submitted');
  assertEquals(job(h).poll_attempts, 1);
});

Deno.test('a worker whose lease expired makes no remote call at all', async () => {
  const h = harness();
  job(h).lease_token = 'someone-else';
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0);
  assertEquals(job(h).state, 'ready', 'the live worker still owns it');
});

Deno.test('a submit that may have reached the provider becomes reconciling, not failed', async () => {
  const h = harness({ submit: () => Promise.reject(new TypeError('error sending request for url')) });
  await runJob(h.deps, h.job);
  assertEquals(job(h).state, 'reconciling');
  assertEquals(h.db.tables.generations[0].status, 'pending', 'an unknown submit must not refund');
});

Deno.test('a provider that rejected the request outright does refund', async () => {
  const h = harness({ submit: () => Promise.reject(new Error('fal 400 invalid prompt')) });
  await runJob(h.deps, h.job);
  assertEquals(h.db.tables.generations[0].status, 'failed');
  assertEquals(job(h).state, 'done');
});

Deno.test('a reconciling job never submits blindly', async () => {
  const h = harness({ state: 'reconciling' });
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0);
  assertEquals(job(h).state, 'reconciling');
  assertEquals(h.db.tables.generations[0].status, 'pending');
});

Deno.test('reconciliation that finds the provider ref resumes polling', async () => {
  const h = harness({
    state: 'submitting',
    reconcile: () => Promise.resolve({ providerRef: 'req_found' }),
  });
  await runJob(h.deps, h.job);
  assertEquals(job(h).state, 'submitted');
  assertEquals(job(h).provider_ref, 'req_found');
});

Deno.test('only an authoritative not_submitted returns a job to ready', async () => {
  const h = harness({ state: 'submitting', reconcile: () => Promise.resolve('not_submitted') });
  await runJob(h.deps, h.job);
  assertEquals(job(h).state, 'ready');
  assertEquals(h.db.tables.generations[0].status, 'pending');
});

Deno.test('a transient poll failure keeps the job and does not refund', async () => {
  const h = harness({
    state: 'submitted',
    providerRef: 'req_1',
    check: () => Promise.reject(new Error('fal status 429')),
  });
  await runJob(h.deps, h.job);
  assertEquals(job(h).state, 'submitted');
  assertEquals(h.db.tables.generations[0].status, 'pending');
});

Deno.test('a retryable_failure honours Retry-After and does not refund', async () => {
  const h = harness({
    state: 'submitted',
    providerRef: 'req_1',
    check: () => Promise.resolve({ state: 'retryable_failure', error: 'fal status 429', retryAfterSeconds: 42 }),
  });
  const before = Date.now();
  await runJob(h.deps, h.job);
  assertEquals(h.db.tables.generations[0].status, 'pending');
  const waitS = (new Date(String(job(h).next_run_at)).getTime() - before) / 1000;
  assertEquals(waitS >= 41 && waitS <= 43, true, `expected ~42s, got ${waitS}`);
});

Deno.test('a terminal provider failure refunds once', async () => {
  const h = harness({
    state: 'submitted',
    providerRef: 'req_1',
    check: () => Promise.resolve({ state: 'failed', error: 'content filtered' }),
  });
  await runJob(h.deps, h.job);
  assertEquals(h.db.tables.generations[0].status, 'failed');
  assertEquals(job(h).state, 'done');
});

Deno.test('a done result finishes the job only when the generation settled', async () => {
  const h = harness({
    state: 'submitted',
    providerRef: 'req_1',
    check: () => Promise.resolve({ state: 'done', bytes: new Uint8Array([1]), contentType: 'image/png' }),
    finish: (db) => {
      db.tables.generations[0].status = 'done';
    },
  });
  await runJob(h.deps, h.job);
  assertEquals(h.finished.length, 1);
  assertEquals(job(h).state, 'done');
});

Deno.test('a finisher that could not store keeps the job runnable', async () => {
  const h = harness({
    state: 'submitted',
    providerRef: 'req_1',
    check: () => Promise.resolve({ state: 'done', bytes: new Uint8Array([1]), contentType: 'image/png' }),
  });
  await runJob(h.deps, h.job);
  assertEquals(h.finished.length, 1);
  assertEquals(job(h).state, 'submitted', 'nothing was stored, so nothing is done');
});

Deno.test('a cancelled-before-dispatch job refunds without calling the provider', async () => {
  const h = harness({ cancelRequested: true });
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0);
  assertEquals(h.cancels.length, 0, 'nothing was sent, so there is nothing to stop');
  assertEquals(h.db.tables.generations[0].status, 'failed');
});

Deno.test('a cancel the provider confirmed refunds; one it did not keeps polling', async () => {
  const confirmed = harness({
    state: 'submitted', providerRef: 'req_1', cancelRequested: true,
    cancel: () => Promise.resolve('cancelled'),
  });
  await runJob(confirmed.deps, confirmed.job);
  assertEquals(confirmed.db.tables.generations[0].status, 'failed');
  assertEquals(confirmed.checks.length, 0);

  const unreachable = harness({
    state: 'submitted', providerRef: 'req_1', cancelRequested: true,
    cancel: () => Promise.resolve('unreachable'),
  });
  await runJob(unreachable.deps, unreachable.job);
  assertEquals(unreachable.db.tables.generations[0].status, 'pending', 'unconfirmed is not cancelled');
  assertEquals(unreachable.checks.length, 1, 'the job is still ours to watch');
});

Deno.test('a payload we can no longer resolve fails before any provider call', async () => {
  const h = harness({ resolve: () => Promise.reject(new Error('upload deleted')) });
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0);
  assertEquals(h.db.tables.generations[0].status, 'failed');
});

Deno.test('an inline result is finished in the same tick', async () => {
  const h = harness({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1]), contentType: 'image/png' },
      }),
    finish: (db) => {
      db.tables.generations[0].status = 'done';
    },
  });
  await runJob(h.deps, h.job);
  assertEquals(h.finished.length, 1);
  assertEquals(job(h).state, 'done');
});

Deno.test('a job already done is left alone', async () => {
  const h = harness({ state: 'done' });
  await runJob(h.deps, h.job);
  assertEquals(h.submits.length, 0);
  assertEquals(h.checks.length, 0);
});
