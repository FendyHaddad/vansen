// One tick of the job worker.
//
// This is the thing that makes "close the tab" safe. Every provider
// conversation — submit, poll, cancel, settle — happens here, on a schedule,
// holding a lease. The gateway only reserves work and reports on it.
//
// A tick is deliberately small and bounded: it claims a handful of jobs, runs
// each one through the state machine, drains a few notifications, and returns
// what it did. Anything it does not finish is still in the database, still
// leased for two minutes, and still there for the next tick.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { claimJobs, type ClaimedJob } from './_shared/jobs/lease.ts';
import { type JobDeps, type ReconcileResult, runJob } from './_shared/jobs/dispatch.ts';
import { drainNotifications, type NotificationDeps } from './_shared/jobs/notifications.ts';
import {
  type ClaimedTrainingJob,
  claimTrainingJobs,
  runTrainingJob,
  type TrainingDeps,
} from './_shared/jobs/training.ts';

export interface WorkerDeps {
  admin: SupabaseClient;
  jobs: Omit<JobDeps, 'admin'>;
  training: Omit<TrainingDeps, 'admin'>;
  notifications: Omit<NotificationDeps, 'admin'>;
  /** Shared secret the scheduler presents. Never optional in production. */
  workerSecret: string | null;
  jobLimit?: number;
  notificationLimit?: number;
}

export interface TickSummary {
  claimed: number;
  ran: number;
  failed: number;
  trainings: number;
  notifications: number;
}

const DEFAULT_JOB_LIMIT = 10;
const DEFAULT_NOTIFICATION_LIMIT = 20;

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
    const summary = await runTick(deps);
    return json(summary, 200);
  };
}

export async function runTick(deps: WorkerDeps): Promise<TickSummary> {
  const summary: TickSummary = {
    claimed: 0,
    ran: 0,
    failed: 0,
    trainings: 0,
    notifications: 0,
  };

  const claimed = await claimJobs(deps.admin, deps.jobLimit ?? DEFAULT_JOB_LIMIT);
  summary.claimed = claimed.length;
  for (const job of claimed) {
    const ok = await runOne(deps, job);
    if (ok) summary.ran += 1;
    if (!ok) summary.failed += 1;
  }

  // Training advances on the same tick and with the same rules. It used to
  // advance only while a client polled GET /personas.
  const trainings = await claimTrainingJobs(deps.admin, deps.jobLimit ?? DEFAULT_JOB_LIMIT);
  for (const job of trainings) {
    const ok = await runOneTraining(deps, job);
    if (ok) summary.trainings += 1;
    if (!ok) summary.failed += 1;
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
async function runOne(deps: WorkerDeps, job: ClaimedJob): Promise<boolean> {
  try {
    await runJob({ ...deps.jobs, admin: deps.admin }, job);
    return true;
  } catch (e) {
    console.error('worker_job_failed', job.id, String(e).slice(0, 300));
    return false;
  }
}

async function runOneTraining(
  deps: WorkerDeps,
  job: ClaimedTrainingJob,
): Promise<boolean> {
  try {
    await runTrainingJob({ ...deps.training, admin: deps.admin }, job);
    return true;
  } catch (e) {
    console.error('worker_training_failed', job.id, String(e).slice(0, 300));
    return false;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type { ClaimedJob, ClaimedTrainingJob, JobDeps, ReconcileResult, TrainingDeps };
