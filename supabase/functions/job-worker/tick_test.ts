// A tick against leases that really expire.
//
// The 2026-09-29 incident: six 4K GPT Image jobs, each a 60–120 s synchronous
// call, claimed on a two-minute lease that nothing renewed and run one after
// another. A call still open when the lease ran out could never be recorded or
// settled, and the next tick found the job in `submitting` with no reference —
// a state reconciliation had no way out of. These tests run the same shape at
// millisecond scale.
import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, type Row } from './_shared/testing/fakes.ts';
import { runTick, type WorkerDeps } from './handler.ts';
import type { ClaimedJob } from './_shared/jobs/lease.ts';
import type { CheckResult, ProviderAdapter, SubmitCtx } from './_shared/providers/types.ts';

const LEASE_MS = 100;
const IMAGE = { state: 'done' as const, bytes: new Uint8Array([1]), contentType: 'image/png' };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

function world(jobCount: number, opts: { state?: string; providerRef?: string | null } = {}) {
  const db = new FakeDb();
  db.tables.generations = [];
  db.tables.jobs = [];
  for (let i = 0; i < jobCount; i++) {
    db.tables.generations.push({
      id: `g${i}`, user_id: 'u0', kind: 'image', family_id: 'gpt-image', status: 'pending',
      charged_plan: 18, charged_pack: 0, failure_code: null,
    });
    db.tables.jobs.push({
      id: `j${i}`, user_id: 'u0', generation_id: `g${i}`, provider: 'openai',
      state: opts.state ?? 'ready', provider_ref: opts.providerRef ?? null,
      lease_token: null, lease_until: null, next_run_at: new Date(0).toISOString(),
      submit_attempts: 0, poll_attempts: 0, reconcile_attempts: 0, dispatch_key: `dk${i}`,
      payload: {}, cancel_requested_at: null, progress_at: new Date().toISOString(),
    });
  }
  installLeases(db);
  return db;
}

/** 0020's lease RPCs, with lease_until compared against the real clock. */
function installLeases(db: FakeDb): void {
  const jobs = () => db.tables.jobs as Row[];
  const held = (args: Row): Row | undefined =>
    jobs().find((j) =>
      j.id === args.p_job && j.lease_token === args.p_token &&
      Date.parse(String(j.lease_until)) > Date.now()
    );
  const leaseUntil = () => new Date(Date.now() + LEASE_MS).toISOString();
  let tokens = 0;

  db.rpcHandlers.fn_claim_jobs = (args) => {
    const now = Date.now();
    const runnable = jobs().filter((j) =>
      j.state !== 'done' && Date.parse(String(j.next_run_at)) <= now &&
      (j.lease_until == null || Date.parse(String(j.lease_until)) < now)
    ).slice(0, Number(args.p_limit));
    for (const j of runnable) {
      j.lease_token = `lease-${++tokens}`;
      j.lease_until = leaseUntil();
    }
    return runnable.map((j) => ({ ...j }));
  };
  db.rpcHandlers.fn_renew_job_lease = (args) => {
    const j = held(args);
    if (!j) return false;
    j.lease_until = leaseUntil();
    return true;
  };
  db.rpcHandlers.fn_begin_submit = (args) => {
    const j = held(args);
    if (!j || j.state !== 'ready') return false;
    j.state = 'submitting';
    j.submit_attempts = Number(j.submit_attempts) + 1;
    return true;
  };
  db.rpcHandlers.fn_record_provider_ref = (args) => {
    const j = held(args);
    if (!j) return false;
    j.provider_ref = args.p_ref;
    return true;
  };
  db.rpcHandlers.fn_count_reconciliation = (args) => {
    const j = held(args);
    if (!j) return null;
    j.reconcile_attempts = Number(j.reconcile_attempts) + 1;
    return j.reconcile_attempts;
  };
  db.rpcHandlers.fn_release_job = (args) => {
    const j = held(args);
    if (!j) return false;
    j.state = args.p_state;
    j.provider_ref = args.p_provider_ref ?? j.provider_ref;
    j.lease_token = null;
    j.lease_until = null;
    j.next_run_at = new Date(Date.now() + Number(args.p_delay_seconds ?? 0) * 1000).toISOString();
    return true;
  };
  db.rpcHandlers.fn_settle_job = (args) => {
    const j = jobs().find((row) => row.id === args.p_job)!;
    const gen = (db.tables.generations as Row[]).find((g) => g.id === j.generation_id)!;
    const live = j.lease_token === args.p_lease_token &&
      Date.parse(String(j.lease_until)) > Date.now();
    if (!live || gen.status !== 'pending') return { settled: false, previous: gen.status, refunded: 0 };
    gen.status = args.p_outcome === 'done' ? 'done' : 'failed';
    gen.failure_code = args.p_failure_code ?? null;
    j.state = 'done';
    j.lease_token = null;
    j.lease_until = null;
    return { settled: true, previous: 'pending', refunded: args.p_outcome === 'done' ? 0 : 18 };
  };
  db.rpcHandlers.fn_claim_notifications = () => [];
}

interface Probe {
  submits: number;
  inFlight: number;
  maxInFlight: number;
}

function workerDeps(
  db: FakeDb,
  submit: (ctx: SubmitCtx, probe: Probe) => Promise<{ providerRef: string; inline?: CheckResult }>,
  over: Partial<WorkerDeps> = {},
): { deps: WorkerDeps; probe: Probe } {
  const probe: Probe = { submits: 0, inFlight: 0, maxInFlight: 0 };
  const adapter: ProviderAdapter = {
    provider: 'openai',
    answersInline: true,
    submit: async (ctx) => {
      probe.submits += 1;
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        return await submit(ctx, probe);
      } finally {
        probe.inFlight -= 1;
      }
    },
    check: () => Promise.resolve({ state: 'running' }),
  };
  const admin = db as unknown as SupabaseClient;
  const deps: WorkerDeps = {
    admin,
    workerSecret: 's',
    heartbeatMs: 10,
    tickBudgetMs: 2_000,
    jobs: {
      adapterFor: () => adapter,
      resolvePayload: () =>
        Promise.resolve({ familyId: 'gpt-image', op: 'generate', prompt: 'p', settings: {}, safetyId: 's' }),
      // What finishJob does with an inline result, minus storage: settle under
      // the lease this tick holds.
      finish: async (job: ClaimedJob) => {
        await admin.rpc('fn_settle_job', {
          p_job: job.id, p_outcome: 'done', p_lease_token: job.lease_token,
        });
      },
      reconcile: () => Promise.resolve('pending' as const),
    },
    notifications: { account: null, sendPush: () => Promise.resolve([]) },
    ...over,
  };
  return { deps, probe };
}

const gens = (db: FakeDb) => (db.tables.generations as Row[]).map((g) => g.status);
const states = (db: FakeDb) => (db.tables.jobs as Row[]).map((j) => j.state);

Deno.test('a synchronous submit that outlives the claim lease still settles (the lease is renewed)', async () => {
  const db = world(1);
  const { deps } = workerDeps(db, async () => {
    await sleep(LEASE_MS * 3);
    return { providerRef: 'inline', inline: IMAGE };
  });
  await runTick(deps);
  assertEquals(gens(db), ['done']);
  assertEquals(states(db), ['done']);
});

Deno.test('slow inline jobs in one tick run side by side, not one after another', async () => {
  const db = world(2);
  const { deps, probe } = workerDeps(db, async () => {
    await sleep(LEASE_MS * 2);
    return { providerRef: 'inline', inline: IMAGE };
  });
  await runTick(deps);
  assertEquals(probe.maxInFlight, 2);
  assertEquals(gens(db), ['done', 'done']);
});

Deno.test('a tick never starts more inline submits than it can hold; the rest wait unclaimed', async () => {
  const db = world(5);
  const { deps, probe } = workerDeps(db, async () => {
    await sleep(5);
    return { providerRef: 'inline', inline: IMAGE };
  }, { maxInlineSubmits: 2 });
  const summary = await runTick(deps);
  assertEquals(probe.submits, 2);
  assertEquals(summary.deferred, 3);
  const waiting = (db.tables.jobs as Row[]).filter((j) => j.state === 'ready');
  assertEquals(waiting.length, 3);
  for (const j of waiting) {
    assertEquals(j.lease_token, null, 'a deferred job is free for the next tick at once');
    assertEquals(j.submit_attempts, 0, 'a deferred job was never sent');
  }
});

Deno.test('a submit still open at the tick budget is aborted and refunded, not stranded', async () => {
  const db = world(1);
  const { deps } = workerDeps(db, async (ctx) => {
    await sleep(10_000, ctx.signal);
    return { providerRef: 'inline', inline: IMAGE };
  }, { tickBudgetMs: 60 });
  const started = Date.now();
  await runTick(deps);
  assertEquals(Date.now() - started < 1_000, true, 'the tick returns at its budget');
  assertEquals(gens(db), ['failed']);
  assertEquals((db.tables.generations as Row[])[0].failure_code, 'timeout');
  assertEquals(states(db), ['done']);
});

Deno.test('jobs left in submitting by a killed tick are refunded by a later one', async () => {
  // What the killed isolate leaves behind: submitting, no reference, lease gone.
  const db = world(4, { state: 'submitting' });
  for (const j of db.tables.jobs as Row[]) j.progress_at = '2026-09-29T04:00:00Z';
  const { deps, probe } = workerDeps(db, () => Promise.reject(new Error('must not resubmit')));
  await runTick(deps);
  assertEquals(probe.submits, 0);
  assertEquals(gens(db), ['failed', 'failed', 'failed', 'failed']);
  assertEquals(states(db), ['done', 'done', 'done', 'done']);
});

Deno.test('overlapping ticks in one isolate share the inline cap', async () => {
  // Ticks now run after the response, so pg_net starts a new one every minute
  // while older ones are still rendering — often in the same 256 MB isolate.
  const db = world(6);
  const { deps, probe } = workerDeps(db, async () => {
    await sleep(LEASE_MS);
    return { providerRef: 'inline', inline: IMAGE };
  }, { maxInlineSubmits: 2, jobLimit: 3 });
  const [a, b] = await Promise.all([runTick(deps), runTick(deps)]);
  assertEquals(probe.maxInFlight, 2);
  assertEquals(a.deferred + b.deferred, 4);
});
