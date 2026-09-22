import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { createWorker, runTick, type WorkerDeps } from './handler.ts';
import type { ClaimedJob } from './_shared/jobs/lease.ts';

const SECRET = 'worker-secret';

interface Recorder {
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  jobsRun: string[];
  drained: number;
}

/**
 * A stub Supabase client that answers only the claim RPCs the tick uses.
 * The state machines themselves are proven in `_shared/jobs`; what matters
 * here is who is allowed to start a tick and what one tick touches.
 */
function stub(rows: {
  jobs?: Partial<ClaimedJob>[];
  notifications?: Record<string, unknown>[];
}): { admin: SupabaseClient; rec: Recorder } {
  const rec: Recorder = { rpcCalls: [], jobsRun: [], drained: 0 };
  const generations = (rows.jobs ?? []).map((j) => ({
    id: j.generation_id ?? 'g0',
    family_id: 'flux',
    kind: 'image',
  }));
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      rec.rpcCalls.push({ name, args });
      if (name === 'fn_claim_jobs') return Promise.resolve({ data: rows.jobs ?? [], error: null });
      if (name === 'fn_claim_notifications') {
        rec.drained += 1;
        return Promise.resolve({ data: rows.notifications ?? [], error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
    from() {
      return {
        select() {
          return {
            in: () => Promise.resolve({ data: generations, error: null }),
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { status: 'pending' }, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { admin, rec };
}

function deps(admin: SupabaseClient, rec: Recorder, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    admin,
    workerSecret: SECRET,
    jobs: {
      adapterFor: () => {
        throw new Error('adapterFor should not be reached in this test');
      },
      resolvePayload: () => Promise.reject(new Error('no payload')),
      finish: () => Promise.resolve(),
      reconcile: () => Promise.resolve('pending' as const),
    },
    notifications: { account: null, sendPush: () => Promise.resolve([]) },
    ...over,
  };
}

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'j0',
    user_id: 'u1',
    generation_id: 'g0',
    family_id: 'flux',
    kind: 'image',
    state: 'submitted',
    provider_ref: 'req_1',
    dispatch_key: 'd0',
    lease_token: 't0',
    lease_until: '2099-01-01T00:00:00Z',
    payload: {},
    submit_attempts: 1,
    poll_attempts: 0,
    cancel_requested_at: null,
    ...over,
  };
}

Deno.test('a request without the worker secret is 401 and claims nothing', async () => {
  const { admin, rec } = stub({ jobs: [job()] });
  const worker = createWorker(deps(admin, rec));
  const res = await worker(new Request('http://worker/', { method: 'POST' }));
  assertEquals(res.status, 401);
  assertEquals(rec.rpcCalls.length, 0);
});

Deno.test('a request with the WRONG worker secret is 401 and claims nothing', async () => {
  const { admin, rec } = stub({ jobs: [job()] });
  const worker = createWorker(deps(admin, rec));
  const res = await worker(
    new Request('http://worker/', { method: 'POST', headers: { 'x-worker-secret': 'nope' } }),
  );
  assertEquals(res.status, 401);
  assertEquals(rec.rpcCalls.length, 0);
});

Deno.test('a worker with no secret configured refuses every caller', async () => {
  const { admin, rec } = stub({ jobs: [job()] });
  const worker = createWorker({ ...deps(admin, rec), workerSecret: null });
  const res = await worker(
    new Request('http://worker/', { method: 'POST', headers: { 'x-worker-secret': SECRET } }),
  );
  assertEquals(res.status, 401);
  assertEquals(rec.rpcCalls.length, 0);
});

Deno.test('GET is not a way to run a tick', async () => {
  const { admin, rec } = stub({ jobs: [job()] });
  const worker = createWorker(deps(admin, rec));
  const res = await worker(
    new Request('http://worker/', { headers: { 'x-worker-secret': SECRET } }),
  );
  assertEquals(res.status, 405);
  assertEquals(rec.rpcCalls.length, 0);
});

Deno.test('an authenticated tick claims jobs and notifications, and no trainings', async () => {
  const { admin, rec } = stub({ jobs: [], notifications: [] });
  const worker = createWorker(deps(admin, rec));
  const res = await worker(
    new Request('http://worker/', { method: 'POST', headers: { 'x-worker-secret': SECRET } }),
  );
  assertEquals(res.status, 200);
  const names = rec.rpcCalls.map((r) => r.name);
  assertEquals(names.includes('fn_claim_jobs'), true);
  assertEquals(names.includes('fn_claim_training_jobs'), false);
  assertEquals(names.includes('fn_claim_notifications'), true);
});

Deno.test('one job that throws does not stop the rest of the tick', async () => {
  const { admin, rec } = stub({ jobs: [job({ id: 'bad' }), job({ id: 'good' })] });
  const d = deps(admin, rec, {
    jobs: {
      adapterFor: (family: string) => ({
        family,
        submit: () => Promise.reject(new Error('unused')),
        check: (ref: string) => {
          rec.jobsRun.push(ref);
          if (rec.jobsRun.length === 1) throw new Error('adapter exploded');
          return Promise.resolve({ state: 'running' as const });
        },
      }),
      resolvePayload: () => Promise.reject(new Error('no payload')),
      finish: () => Promise.resolve(),
      reconcile: () => Promise.resolve('pending' as const),
    } as unknown as WorkerDeps['jobs'],
  });

  const summary = await runTick(d);

  // The first job's adapter throws inside check, which dispatch turns into a
  // retry rather than a crash; both jobs are still attempted.
  assertEquals(rec.jobsRun.length, 2);
  assertEquals(summary.claimed, 2);
  assertEquals(summary.failed, 0);
});

Deno.test('a job whose dispatch throws outright is counted, not fatal', async () => {
  const { admin, rec } = stub({ jobs: [job({ id: 'bad' })] });
  const d = deps(admin, rec, {
    jobs: {
      adapterFor: () => {
        throw new Error('no adapter for this family');
      },
      resolvePayload: () => Promise.reject(new Error('no payload')),
      finish: () => Promise.resolve(),
      reconcile: () => Promise.resolve('pending' as const),
    },
  });

  const summary = await runTick(d);

  assertEquals(summary.failed, 1);
});

Deno.test('a failed drain does not fail the tick', async () => {
  const { admin, rec } = stub({});
  const broken = {
    ...admin,
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'fn_claim_notifications') {
        return Promise.resolve({ data: null, error: { message: 'outbox unavailable' } });
      }
      return (admin as unknown as { rpc: (n: string, a: Record<string, unknown>) => unknown })
        .rpc(name, args);
    },
  } as unknown as SupabaseClient;

  const summary = await runTick(deps(broken, rec));

  assertEquals(summary.notifications, 0);
});
