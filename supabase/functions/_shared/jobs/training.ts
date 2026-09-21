// Persona training, run offline.
//
// Training is a twenty-minute provider job that used to advance only while a
// client sat on `GET /personas`. A customer who closed the tab left their
// persona in `training` until they came back — and the credits with it. This
// is the same state machine as generation dispatch, with the same rule: a
// submit whose outcome we do not know is never repeated on a guess.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { TrainingCheck } from '../providers/fal.ts';
import { classifyProviderError } from '../providers/provider-errors.ts';
import { backoffSeconds, type JobState } from './lease.ts';

export interface ClaimedTrainingJob {
  id: string;
  user_id: string;
  persona_id: string;
  state: JobState;
  provider: string;
  provider_ref: string | null;
  dispatch_key: string;
  lease_token: string;
  payload: Record<string, unknown>;
  submit_attempts: number;
  poll_attempts: number;
  cancel_requested_at: string | null;
}

export interface TrainingDeps {
  admin: SupabaseClient;
  /** Signs the stored photo zip fresh; throws when the object is gone. */
  signZip(path: string): Promise<string>;
  submit(zipUrl: string): Promise<string>;
  check(providerRef: string): Promise<TrainingCheck>;
}

const RECONCILE_ALERT_AFTER = 10;

export async function claimTrainingJobs(
  admin: SupabaseClient,
  limit: number,
): Promise<ClaimedTrainingJob[]> {
  const { data, error } = await admin.rpc('fn_claim_training_jobs', { p_limit: limit });
  if (error) throw new Error(`fn_claim_training_jobs: ${error.message}`);
  return (data ?? []) as ClaimedTrainingJob[];
}

export async function runTrainingJob(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
): Promise<void> {
  if (job.state === 'done') return;
  if (job.state === 'ready' && job.cancel_requested_at) {
    // Nothing was sent, so nobody is billing us for it.
    await settle(deps, job, 'failed', null, 'cancelled');
    return;
  }
  if (job.state === 'submitted') return await pollTraining(deps, job);
  if (job.state === 'submitting' || job.state === 'reconciling') {
    return await reconcileTraining(deps, job);
  }
  await submitTraining(deps, job);
}

async function submitTraining(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
): Promise<void> {
  const started = await callBoolean(deps.admin, 'fn_begin_training_submit', {
    p_job: job.id,
    p_token: job.lease_token,
  });
  if (!started) return;

  const zipPath = typeof job.payload.zipPath === 'string' ? job.payload.zipPath : '';
  let zipUrl: string;
  try {
    // Signed here, not when the customer clicked: an hour-old URL is a dead
    // link by the time a backed-off job runs.
    if (!zipPath) throw new Error('training payload has no zipPath');
    zipUrl = await deps.signZip(zipPath);
  } catch (e) {
    console.error('training_payload_failed', job.id, String(e).slice(0, 200));
    await settle(deps, job, 'failed', null, 'payload_unavailable');
    return;
  }

  try {
    const providerRef = await deps.submit(zipUrl);
    await callBoolean(deps.admin, 'fn_record_training_ref', {
      p_job: job.id,
      p_token: job.lease_token,
      p_ref: providerRef,
    });
    await release(deps, job, 'submitted', providerRef, backoffSeconds(0), null);
  } catch (e) {
    await afterFailedTrainingSubmit(deps, job, e);
  }
}

async function afterFailedTrainingSubmit(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
  cause: unknown,
): Promise<void> {
  const error = String(cause).slice(0, 300);
  if (classifyProviderError(cause) === 'terminal') {
    console.error('training_submit_rejected', job.id, error);
    await settle(deps, job, 'failed', null, error);
    return;
  }
  console.error('training_submit_unknown', job.id, error);
  await release(
    deps,
    job,
    'reconciling',
    null,
    backoffSeconds(job.submit_attempts + 1),
    error,
  );
}

async function pollTraining(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
): Promise<void> {
  const ref = job.provider_ref;
  if (!ref) {
    await release(deps, job, 'reconciling', null, backoffSeconds(job.poll_attempts), null);
    return;
  }
  let result: TrainingCheck;
  try {
    result = await deps.check(ref);
  } catch (e) {
    const error = String(cause(e)).slice(0, 300);
    // A poll that never reached the provider says nothing about the training.
    if (classifyProviderError(e) === 'terminal') {
      await settle(deps, job, 'failed', null, error);
      return;
    }
    await release(deps, job, 'submitted', null, backoffSeconds(job.poll_attempts + 1), error);
    return;
  }

  if (result.state === 'running') {
    await release(deps, job, 'submitted', null, backoffSeconds(job.poll_attempts + 1), null);
    return;
  }
  if (result.state === 'failed') {
    await settle(deps, job, 'failed', null, result.error);
    return;
  }
  await settle(deps, job, 'done', result.loraUrl, null);
}

async function reconcileTraining(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
): Promise<void> {
  // A provider reference we recorded IS the authoritative answer to "did this
  // reach them" — poll it rather than sending a second training run.
  if (job.provider_ref) {
    await release(deps, job, 'submitted', null, 0, null);
    return;
  }
  const attempts = job.submit_attempts + job.poll_attempts;
  if (attempts >= RECONCILE_ALERT_AFTER) {
    console.error('training_reconcile_stuck', job.id, job.dispatch_key, attempts);
  }
  await release(deps, job, 'reconciling', null, backoffSeconds(attempts), null);
}

async function settle(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
  outcome: 'done' | 'failed',
  loraUrl: string | null,
  error: string | null,
): Promise<void> {
  const { error: rpcError } = await deps.admin.rpc('fn_settle_training', {
    p_job: job.id,
    p_token: job.lease_token,
    p_outcome: outcome,
    p_lora_url: loraUrl,
    p_error: error,
  });
  if (rpcError) throw new Error(`fn_settle_training: ${rpcError.message}`);
}

function release(
  deps: TrainingDeps,
  job: ClaimedTrainingJob,
  state: JobState,
  providerRef: string | null,
  delaySeconds: number,
  error: string | null,
): Promise<boolean> {
  return callBoolean(deps.admin, 'fn_release_training_job', {
    p_job: job.id,
    p_token: job.lease_token,
    p_state: state,
    p_provider_ref: providerRef,
    p_delay_seconds: Math.max(0, Math.round(delaySeconds)),
    p_error: error,
  });
}

function cause(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function callBoolean(
  admin: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data === true;
}
