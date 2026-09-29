// One tick of the job worker.
//
// This is the thing that makes "close the tab" safe. Every provider
// conversation — submit, poll, cancel, settle — happens here, on a schedule,
// holding a lease. The gateway only reserves work and reports on it.
//
// A tick is deliberately small and bounded: it claims a handful of jobs, runs
// them side by side through the state machine, drains a few notifications, and
// returns what it did. Anything it does not finish is still in the database,
// still leased for two minutes, and still there for the next tick.
//
// Three bounds, all from the 2026-09-29 incident, when a batch of 4K GPT Image
// jobs (each a 60–120 s synchronous call) ran one after another on a lease
// nothing renewed, and every call still open at two minutes was stranded:
// - each running job's lease is renewed while it runs;
// - provider calls are aborted at the tick budget, before the platform's wall
//   clock kills the isolate and takes the answer with it;
// - only a few synchronous submits run at once per isolate, because each holds
//   a whole image in memory; the rest go straight back for the next tick.
//
// In production the tick runs AFTER the response (EdgeRuntime.waitUntil). The
// request idle timeout is 150 s on every plan; the wall clock that bounds
// background work is 400 s on paid plans. Answering pg_net first is what lets a
// tick use the longer of the two.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { claimJobs, type ClaimedJob, releaseJob, renewLease } from './_shared/jobs/lease.ts';
import { type JobDeps, type ReconcileResult, runJob } from './_shared/jobs/dispatch.ts';
import { drainNotifications, type NotificationDeps } from './_shared/jobs/notifications.ts';

export interface WorkerDeps {
  admin: SupabaseClient;
  jobs: Omit<JobDeps, 'admin'>;
  notifications: Omit<NotificationDeps, 'admin'>;
  /** Shared secret the scheduler presents. Never optional in production. */
  workerSecret: string | null;
  jobLimit?: number;
  notificationLimit?: number;
  /** Time from the start of a tick by which every provider call must have answered. */
  tickBudgetMs?: number;
  /** Synchronous (inline) submits one tick may hold open at once. */
  maxInlineSubmits?: number;
  heartbeatMs?: number;
  /**
   * Keeps the tick alive after the response (EdgeRuntime.waitUntil). Without
   * it the tick runs inside the request and its summary is the response.
   */
  runInBackground?: (work: Promise<unknown>) => void;
}

export interface TickSummary {
  claimed: number;
  ran: number;
  failed: number;
  /** Inline submits handed straight back because the tick was full. */
  deferred: number;
  notifications: number;
}

const DEFAULT_JOB_LIMIT = 10;
const DEFAULT_NOTIFICATION_LIMIT = 20;
/**
 * The free plan's wall clock is 150 s. What is left after the budget is for
 * decoding, storing and settling an image that came back at the last moment.
 */
const DEFAULT_TICK_BUDGET_MS = 115_000;
/** A 4K PNG arrives as ~30 MB of base64; the isolate has 256 MB. */
const DEFAULT_MAX_INLINE_SUBMITS = 2;
/** Leases last two minutes (fn_claim_jobs); renew well inside that. */
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Inline submits running in this isolate, across every tick it is serving.
 * Background ticks overlap — pg_net starts one a minute and a tick can run for
 * minutes — and they share one 256 MB heap, so the cap cannot be per tick.
 */
let inlineInFlight = 0;

/**
 * The HTTP surface is one POST. It exists because pg_cron pokes it; it is not
 * a public API, and it authenticates before it touches anything.
 */
export function createWorker(deps: WorkerDeps): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method !== 'POST') {
      return json({ error: { code: 'method_not_allowed' } }, 405);
    }
    // A missing secret is a misconfiguration, not an open door.
    if (!deps.workerSecret) {
      console.error('worker_secret_missing');
      return json({ error: { code: 'unauthorized' } }, 401);
    }
    if (req.headers.get('x-worker-secret') !== deps.workerSecret) {
      return json({ error: { code: 'unauthorized' } }, 401);
    }
    if (!deps.runInBackground) return json(await runTick(deps), 200);
    deps.runInBackground(runTick(deps).then(
      (summary) => console.log(JSON.stringify({ event: 'worker_tick', ...summary })),
      (e) => console.error('worker_tick_failed', String(e).slice(0, 300)),
    ));
    return json({ accepted: true }, 202);
  };
}

export async function runTick(deps: WorkerDeps): Promise<TickSummary> {
  const summary: TickSummary = {
    claimed: 0,
    ran: 0,
    failed: 0,
    deferred: 0,
    notifications: 0,
  };

  const claimed = await claimJobs(deps.admin, deps.jobLimit ?? DEFAULT_JOB_LIMIT);
  summary.claimed = claimed.length;
  const { admitted, slotted } = await deferExcessInline(deps, claimed);
  summary.deferred = claimed.length - admitted.length;

  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('tick budget spent', 'TimeoutError')),
    deps.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS,
  );
  try {
    const results = await Promise.all(
      admitted.map((job) => runOne(deps, job, deadline.signal, slotted.has(job.id))),
    );
    summary.ran = results.filter((ok) => ok).length;
    summary.failed = results.length - summary.ran;
  } finally {
    clearTimeout(timer);
  }

  // Delivery is independent of any client request, and a push failure must
  // never take a tick down with it.
  const drained = await drainNotifications(
    { ...deps.notifications, admin: deps.admin },
    deps.notificationLimit ?? DEFAULT_NOTIFICATION_LIMIT,
  ).catch((e) => {
    console.error('worker_drain_failed', String(e).slice(0, 200));
    return { claimed: 0, sent: 0, failed: 0, abandoned: 0 };
  });
  summary.notifications = drained.sent;
  return summary;
}

/**
 * One job's failure is its own. A thrown adapter, a broken payload or a lost
 * connection must not stop the other jobs in this tick — their leases would
 * expire and the whole batch would stall behind one bad row.
 */
async function runOne(
  deps: WorkerDeps,
  job: ClaimedJob,
  signal: AbortSignal,
  holdsInlineSlot: boolean,
): Promise<boolean> {
  const stopHeartbeat = startHeartbeat(deps, job);
  try {
    await runJob({ ...deps.jobs, admin: deps.admin, signal }, job);
    return true;
  } catch (e) {
    console.error('worker_job_failed', job.id, String(e).slice(0, 300));
    return false;
  } finally {
    stopHeartbeat();
    if (holdsInlineSlot) inlineInFlight -= 1;
  }
}

/**
 * Keep the lease alive while the job runs. A synchronous 4K render outlives a
 * two-minute lease, and a job whose lease lapses mid-call can neither record
 * nor settle what comes back.
 */
function startHeartbeat(deps: WorkerDeps, job: ClaimedJob): () => void {
  let stopped = false;
  const beat = async () => {
    const held = await renewLease(deps.admin, job.id, job.lease_token).catch((e) => {
      console.error('worker_lease_renew_failed', job.id, String(e).slice(0, 200));
      return true;
    });
    // After the job settles its lease is gone by design; only a live run can lose it.
    if (!held && !stopped) console.error('worker_lease_lost', job.id);
  };
  const interval = setInterval(beat, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Take an isolate-wide inline slot for each inline submit that fits, and hand
 * back the rest untouched: still `ready`, never sent, free for the next tick.
 */
async function deferExcessInline(
  deps: WorkerDeps,
  claimed: ClaimedJob[],
): Promise<{ admitted: ClaimedJob[]; slotted: Set<string> }> {
  const cap = deps.maxInlineSubmits ?? DEFAULT_MAX_INLINE_SUBMITS;
  const admitted: ClaimedJob[] = [];
  const slotted = new Set<string>();
  for (const job of claimed) {
    if (!isInlineSubmit(deps, job)) {
      admitted.push(job);
      continue;
    }
    if (inlineInFlight < cap) {
      inlineInFlight += 1;
      slotted.add(job.id);
      admitted.push(job);
      continue;
    }
    // A release that fails costs only time: the lease lapses in two minutes.
    await releaseJob(deps.admin, job.id, job.lease_token, { state: 'ready' }).catch((e) => {
      console.error('worker_defer_failed', job.id, String(e).slice(0, 200));
    });
  }
  return { admitted, slotted };
}

function isInlineSubmit(deps: WorkerDeps, job: ClaimedJob): boolean {
  if (job.state !== 'ready' || job.cancel_requested_at) return false;
  try {
    return deps.jobs.adapterFor(job.family_id).answersInline === true;
  } catch {
    // runJob reports a family with no adapter; it is not ours to decide here.
    return false;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type { ClaimedJob, JobDeps, ReconcileResult };
