// A worker tick driven against FakeDb.
//
// Since P5 no route talks to a provider, so "the adapter received the request
// the customer was charged for" can only be asserted by running the worker.
// These are the lease RPCs of 0020 reduced to what the state machine reads:
// state, token, attempt counters. The real fencing is proven in
// supabase/tests/dispatch.sql.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { FakeDb, Row } from './fakes.ts';
import { type ClaimedJob } from '../jobs/lease.ts';
import { type JobDeps, runJob } from '../jobs/dispatch.ts';
import type { CheckResult, ProviderAdapter, SubmitCtx } from '../providers/types.ts';
import { resolvePayload } from '../jobs/payload.ts';
import type { StorageAdapter } from '../storage/index.ts';

const LEASE = 'lease-token';

/** Registers fn_claim_jobs and the fenced lease writes on a FakeDb. */
export function installDispatchRpcs(db: FakeDb): void {
  const jobs = () => (db.tables.jobs ?? []) as Row[];
  const leased = (args: Row): Row | undefined =>
    jobs().find((j) => j.id === args.p_job && j.lease_token === args.p_token);

  db.rpcHandlers.fn_claim_jobs = () => {
    const claimed = jobs().filter((j) => j.state !== 'done');
    for (const job of claimed) {
      job.lease_token = LEASE;
      job.lease_until = '2099-01-01T00:00:00Z';
    }
    return claimed.map((j) => ({ ...j }));
  };
  db.rpcHandlers.fn_begin_submit = (args) => {
    const job = leased(args);
    if (!job || job.state !== 'ready') return false;
    job.state = 'submitting';
    job.submit_attempts = Number(job.submit_attempts ?? 0) + 1;
    return true;
  };
  db.rpcHandlers.fn_record_provider_ref = (args) => {
    const job = leased(args);
    if (!job) return false;
    job.provider_ref = args.p_ref;
    return true;
  };
  db.rpcHandlers.fn_count_poll = (args) => {
    const job = leased(args);
    if (!job) return false;
    job.poll_attempts = Number(job.poll_attempts ?? 0) + 1;
    return true;
  };
  db.rpcHandlers.fn_release_job = (args) => {
    const job = leased(args);
    if (!job) return false;
    job.state = args.p_state;
    job.provider_ref = args.p_provider_ref ?? job.provider_ref;
    job.last_error = args.p_error ?? null;
    job.lease_token = null;
    job.lease_until = null;
    return true;
  };
  db.rpcHandlers.fn_renew_job_lease = (args) => leased(args) !== undefined;
}

export interface TickOptions {
  adapterFor?(familyId: string): ProviderAdapter;
  resolvePayload?(job: ClaimedJob): Promise<SubmitCtx>;
  finish?(job: ClaimedJob, result: CheckResult): Promise<void>;
  reconcile?: JobDeps['reconcile'];
}

/** Reads and signs through FakeStorage's `media` bucket. */
function fakeStorage(db: FakeDb): StorageAdapter {
  const adapter: StorageAdapter = {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      await db.storage.from('media').upload(key, bytes, { contentType });
    },
    delete: async (key: string) => {
      await db.storage.from('media').remove([key]);
    },
    signedUrl: async (key: string, ttlS: number) => {
      const { data } = await db.storage.from('media').createSignedUrl(key, ttlS);
      return data?.signedUrl ?? `https://fake.media/${key}`;
    },
  } as unknown as StorageAdapter;
  return adapter;
}

/**
 * Claims and runs every runnable job once, exactly as one worker tick would.
 */
export async function runWorkerTick(
  db: FakeDb,
  opts: TickOptions = {},
): Promise<ClaimedJob[]> {
  installDispatchRpcs(db);
  const admin = db as unknown as SupabaseClient;
  const deps: JobDeps = {
    admin,
    adapterFor: opts.adapterFor ?? (() => {
      throw new Error('this tick was not expected to reach a provider');
    }),
    resolvePayload: opts.resolvePayload ?? ((job) =>
      // The real resolver, against the fake database and storage: a route test
      // that asserts what the provider received should exercise the code that
      // signs it, not a stand-in for it.
      resolvePayload({ admin, storageFor: () => fakeStorage(db) }, job)),
    finish: opts.finish ?? (() => Promise.resolve()),
    reconcile: opts.reconcile ?? (() => Promise.resolve('pending' as const)),
  };

  const { data } = await admin.rpc('fn_claim_jobs', { p_limit: 20 });
  const rows = (data ?? []) as Row[];
  const claimed: ClaimedJob[] = [];
  for (const row of rows) {
    const gen = (db.tables.generations ?? []).find((g) => g.id === row.generation_id);
    if (!gen) continue;
    const job = {
      ...(row as unknown as ClaimedJob),
      family_id: String(gen.family_id),
      kind: gen.kind === 'video' ? 'video' : 'image',
    } as ClaimedJob;
    claimed.push(job);
    await runJob(deps, job);
  }
  return claimed;
}
