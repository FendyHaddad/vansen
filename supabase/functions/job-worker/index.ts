// Production composition for the job worker. Behaviour lives in handler.ts.
//
// pg_cron calls this every minute with the shared secret; it claims leases,
// talks to providers and settles work. It is the only place a provider is
// called, so `_shared/providers` and `_shared/jobs` must both be bundled with
// this function on deploy.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createWorker } from './handler.ts';
import { adapterFor } from './_shared/providers/index.ts';
import { storageFor } from './_shared/storage/index.ts';
import { parseServiceAccount, sendGenerationPush } from './_shared/push.ts';
import { finishJob } from './_shared/jobs/store.ts';
import { resolvePayload } from './_shared/jobs/payload.ts';
import type { ClaimedJob } from './_shared/jobs/lease.ts';
import type { CheckResult } from './_shared/providers/types.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

/** Optional override; raise it on a plan with a longer wall clock (Pro: 400 s). */
const budgetS = Number(Deno.env.get('JOB_TICK_BUDGET_S'));

declare const EdgeRuntime: { waitUntil<T>(promise: Promise<T>): Promise<T> };

const worker = createWorker({
  admin,
  workerSecret: Deno.env.get('JOB_WORKER_SECRET') ?? null,
  ...(budgetS > 0 ? { tickBudgetMs: budgetS * 1000 } : {}),
  // Answer pg_net at once and keep working: the request idle timeout is 150 s
  // on every plan, the background wall clock is 400 s on paid ones.
  runInBackground: (work) => void EdgeRuntime.waitUntil(work),
  jobs: {
    adapterFor,
    resolvePayload: (job: ClaimedJob) => resolvePayload({ admin, storageFor }, job),
    finish: (job: ClaimedJob, result: CheckResult) =>
      finishJob({ admin, storageFor, fetch }, {
        id: job.id,
        user_id: job.user_id,
        generation_id: job.generation_id,
        attempts: job.poll_attempts,
        lease_token: job.lease_token,
      }, result),
    // No provider in the catalogue exposes a lookup by our own dispatch key
    // yet (see the capability record). Until one is verified, an unknown
    // submit stays unknown: it is held, backed off and alerted on, never
    // resubmitted and never refunded on a guess.
    reconcile: () => Promise.resolve('pending' as const),
  },
  notifications: {
    account: parseServiceAccount(Deno.env.get('FCM_SERVICE_ACCOUNT')),
    sendPush: sendGenerationPush,
  },
});

Deno.serve(worker);
