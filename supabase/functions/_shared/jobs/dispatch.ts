// The job state machine. One tick of one worker, for one job.
//
//   ready       nothing has been sent yet
//   submitting  we are about to call, or did call and do not know the outcome
//   submitted   the provider has it, and we have its reference
//   reconciling we must ask the provider what happened before doing anything
//   done        settled — the generation is terminal
//
// The rule the whole file exists for: **a request that may have reached the
// provider is never repeated on a guess.** A timeout, a dropped connection or a
// crash between the call and the database write all land in `reconciling`,
// where the only way out is an authoritative answer from the provider. The old
// code refunded on any thrown error and resubmitted on the next poll, which
// both abandoned jobs that were about to succeed and paid for the same render
// twice.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { CheckResult, ProviderAdapter, SubmitCtx } from '../providers/types.ts';
import { classifyProviderError } from '../providers/provider-errors.ts';
import { settleFailed } from './settlement.ts';
import {
  backoffSeconds,
  beginSubmit,
  type ClaimedJob,
  countPoll,
  recordProviderRef,
  releaseJob,
} from './lease.ts';

/** What reconciliation found out. Nothing else may move a job out of it. */
export type ReconcileResult = 'pending' | 'not_submitted' | { providerRef: string };

export interface JobDeps {
  admin: SupabaseClient;
  adapterFor(familyId: string): ProviderAdapter;
  resolvePayload(job: ClaimedJob): Promise<SubmitCtx>;
  finish(job: ClaimedJob, result: CheckResult): Promise<void>;
  reconcile(job: ClaimedJob): Promise<ReconcileResult>;
}

/** After this many fruitless reconciliations the job needs a human. */
const RECONCILE_ALERT_AFTER = 10;

export async function runJob(deps: JobDeps, job: ClaimedJob): Promise<void> {
  if (job.state === 'done') return;
  if (job.state === 'ready' && job.cancel_requested_at) {
    return await cancelBeforeDispatch(deps, job);
  }
  if (job.state === 'submitted') return await pollJob(deps, job);
  if (job.state === 'submitting' || job.state === 'reconciling') {
    return await reconcileJob(deps, job);
  }
  await submitJob(deps, job);
}

// ------------------------------------------------------------------- submit

export async function submitJob(deps: JobDeps, job: ClaimedJob): Promise<void> {
  // Persist the intent first. If this does not update a row we no longer own
  // the job, and the remote call must not happen at all.
  const started = await beginSubmit(deps.admin, job.id, job.lease_token);
  if (!started) return;

  let ctx: SubmitCtx;
  try {
    // References are signed here, not at submission time hours ago: a job that
    // waited out its signed URLs would hand the provider a dead link.
    ctx = await deps.resolvePayload(job);
  } catch (e) {
    // Missing, foreign or deleted inputs are terminal: there is nothing to
    // send and nothing was sent.
    console.error('dispatch_payload_failed', job.id, String(e).slice(0, 200));
    await settleFailed(deps.admin, job.id, 'payload_unavailable', {
      leaseToken: job.lease_token,
    });
    return;
  }

  try {
    const submitted = await deps.adapterFor(job.family_id).submit(ctx);
    await recordProviderRef(deps.admin, job.id, job.lease_token, submitted.providerRef);
    if (submitted.inline) {
      await deps.finish(job, submitted.inline);
      await finishOrRetry(deps, job, 'submitted');
      return;
    }
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'submitted',
      providerRef: submitted.providerRef,
      delaySeconds: backoffSeconds(0),
    });
  } catch (e) {
    await afterFailedSubmit(deps, job, e);
  }
}

async function afterFailedSubmit(
  deps: JobDeps,
  job: ClaimedJob,
  cause: unknown,
): Promise<void> {
  const error = String(cause).slice(0, 300);
  // A provider that rejected the request outright never started work, so the
  // customer can be refunded honestly.
  if (classifyProviderError(cause) === 'terminal') {
    console.error('dispatch_submit_rejected', job.id, error);
    await settleFailed(deps.admin, job.id, error, { leaseToken: job.lease_token });
    return;
  }
  // Everything else might have reached the provider. It stays ours to find out.
  console.error('dispatch_submit_unknown', job.id, error);
  await releaseJob(deps.admin, job.id, job.lease_token, {
    state: 'reconciling',
    delaySeconds: backoffSeconds(job.submit_attempts + 1),
    error,
  });
}

async function cancelBeforeDispatch(deps: JobDeps, job: ClaimedJob): Promise<void> {
  // Nothing was ever sent, so nobody is billing us: this is the one
  // cancellation that needs no provider confirmation.
  await settleFailed(deps.admin, job.id, 'cancelled', {
    leaseToken: job.lease_token,
    failureCode: 'cancelled',
  });
}

// --------------------------------------------------------------------- poll

export async function pollJob(deps: JobDeps, job: ClaimedJob): Promise<void> {
  const ref = job.provider_ref;
  if (!ref) {
    // `submitted` with no reference is not a state we can act on; ask.
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'reconciling',
      delaySeconds: backoffSeconds(job.poll_attempts),
    });
    return;
  }
  if (!await countPoll(deps.admin, job.id, job.lease_token)) return;
  const adapter = deps.adapterFor(job.family_id);
  if (job.cancel_requested_at) {
    const stopped = await cancelWithProvider(deps, job, adapter, ref);
    if (stopped) return;
  }

  let result: CheckResult;
  try {
    result = await adapter.check(ref);
  } catch (e) {
    await afterFailedPoll(deps, job, e);
    return;
  }

  if (result.state === 'running') {
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'submitted',
      delaySeconds: backoffSeconds(job.poll_attempts),
    });
    return;
  }
  if (result.state === 'retryable_failure') {
    // The provider is briefly unavailable. The job is still running and still
    // billing us; refunding here is the mistake this state exists to prevent.
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'submitted',
      delaySeconds: backoffSeconds(job.poll_attempts, result.retryAfterSeconds),
      error: result.error,
    });
    return;
  }
  if (result.state === 'failed') {
    await settleFailed(deps.admin, job.id, result.error, { leaseToken: job.lease_token });
    return;
  }
  await deps.finish(job, result);
  await finishOrRetry(deps, job, 'submitted');
}

async function afterFailedPoll(
  deps: JobDeps,
  job: ClaimedJob,
  cause: unknown,
): Promise<void> {
  const error = String(cause).slice(0, 300);
  // A poll that could not reach the provider says nothing about the job. Only
  // a provider that answered "this request is not a thing" is terminal.
  if (classifyProviderError(cause) === 'terminal') {
    await settleFailed(deps.admin, job.id, error, { leaseToken: job.lease_token });
    return;
  }
  await releaseJob(deps.admin, job.id, job.lease_token, {
    state: 'submitted',
    delaySeconds: backoffSeconds(job.poll_attempts),
    error,
  });
}

/** Returns true when the job is now terminal and this tick is over. */
async function cancelWithProvider(
  deps: JobDeps,
  job: ClaimedJob,
  adapter: ProviderAdapter,
  ref: string,
): Promise<boolean> {
  if (!adapter.cancel) return false;
  const outcome = await adapter.cancel(ref).catch(() => 'unreachable' as const);
  // Only a provider that confirmed it stopped earns a refund. Anything else
  // and the render is probably still running, and still being billed to us.
  if (outcome !== 'cancelled') return false;
  await settleFailed(deps.admin, job.id, 'cancelled', {
    leaseToken: job.lease_token,
    failureCode: 'cancelled',
  });
  return true;
}

// -------------------------------------------------------------- reconciling

export async function reconcileJob(deps: JobDeps, job: ClaimedJob): Promise<void> {
  // Inline bytes cannot be fetched again. A real remote reference can.
  if (job.provider_ref && job.provider_ref !== 'inline') return await pollJob(deps, job);
  const { data: attempts, error } = await deps.admin.rpc('fn_count_reconciliation', {
    p_job: job.id, p_token: job.lease_token,
  });
  if (error) throw new Error(`reconciliation_count_failed ${error.message}`);
  if (attempts == null) return; // Lost lease: do not act on stale ownership.
  const found = await deps.reconcile(job).catch((e) => {
    console.error('dispatch_reconcile_failed', job.id, String(e).slice(0, 200));
    return 'pending' as const;
  });

  if (found === 'not_submitted') {
    // Authoritative: the provider never got it, so starting over is honest.
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'ready',
      delaySeconds: backoffSeconds(job.submit_attempts),
    });
    return;
  }
  if (found !== 'pending') {
    await releaseJob(deps.admin, job.id, job.lease_token, {
      state: 'submitted',
      providerRef: found.providerRef,
      delaySeconds: 0,
    });
    return;
  }

  // Still unknown. Back off and keep it — a retry count is not evidence that a
  // paid remote job failed, so this never becomes a refund on its own.
  if (attempts >= RECONCILE_ALERT_AFTER) {
    const { error } = await deps.admin.rpc('fn_raise_alert', {
      p_kind: 'jobs_stuck', p_severity: 'warn',
      p_detail: { jobId: job.id, dispatchKey: job.dispatch_key, attempts },
    });
    if (error) throw new Error(`reconciliation_alert_failed ${error.message}`);
  }
  await releaseJob(deps.admin, job.id, job.lease_token, {
    state: 'reconciling',
    delaySeconds: backoffSeconds(attempts),
  });
}

// ------------------------------------------------------------------ helpers

/**
 * P4's finisher decides whether the generation actually became terminal — it
 * verifies the stored media first. Read that decision rather than assuming it.
 */
async function finishOrRetry(
  deps: JobDeps,
  job: ClaimedJob,
  retryState: 'submitted',
): Promise<void> {
  const { data, error } = await deps.admin
    .from('generations')
    .select('status')
    .eq('id', job.generation_id)
    .maybeSingle();
  if (error) {
    console.error('dispatch_status_read_failed', job.id, error.message);
    return;
  }
  const terminal = data?.status === 'done' || data?.status === 'failed';
  if (terminal) {
    await releaseJob(deps.admin, job.id, job.lease_token, { state: 'done' });
    return;
  }
  await releaseJob(deps.admin, job.id, job.lease_token, {
    state: retryState,
    delaySeconds: backoffSeconds(job.poll_attempts),
  });
}
