// Leases: the only thing that gives a worker the right to act on a job.
//
// Two workers claiming the same row is not the interesting case — `for update
// skip locked` handles that. The interesting case is the worker that claimed a
// job, went away mid-flight, and comes back after someone else took over. Every
// write here is fenced on (id, lease_token, lease_until > now()), and every one
// of them reports whether it actually changed a row. A zero-row update is not a
// success; treating it as one is how a stale worker overwrites the live one.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type JobState = 'ready' | 'submitting' | 'submitted' | 'reconciling' | 'done';

export interface StoredPayloadShape {
  [key: string]: unknown;
}

export interface ClaimedJob {
  id: string;
  user_id: string;
  generation_id: string;
  /** Joined from the generation: the jobs row does not carry it. */
  family_id: string;
  kind: 'image' | 'video';
  state: JobState;
  provider_ref: string | null;
  dispatch_key: string;
  lease_token: string;
  lease_until: string;
  payload: StoredPayloadShape;
  submit_attempts: number;
  poll_attempts: number;
  cancel_requested_at: string | null;
}

export interface ReleaseOptions {
  state: JobState;
  providerRef?: string | null;
  delaySeconds?: number;
  error?: string | null;
}

/** Claim runnable jobs and join the family/kind the adapter needs. */
export async function claimJobs(
  admin: SupabaseClient,
  limit: number,
): Promise<ClaimedJob[]> {
  const { data, error } = await admin.rpc('fn_claim_jobs', { p_limit: limit });
  if (error) throw new Error(`fn_claim_jobs: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.generation_id));
  const { data: gens, error: genError } = await admin
    .from('generations')
    .select('id,family_id,kind')
    .in('id', ids);
  if (genError) throw new Error(`claim generations: ${genError.message}`);
  const byId = new Map(
    (gens ?? []).map((g) => [String(g.id), g as { family_id: string; kind: string }]),
  );

  const claimed: ClaimedJob[] = [];
  for (const row of rows) {
    const gen = byId.get(String(row.generation_id));
    // A job whose generation we cannot read is not runnable: submitting it
    // would mean guessing which provider it belongs to.
    if (!gen) {
      console.error('claim_without_generation', row.id);
      continue;
    }
    claimed.push({
      ...(row as unknown as ClaimedJob),
      family_id: gen.family_id,
      kind: gen.kind === 'video' ? 'video' : 'image',
    });
  }
  return claimed;
}

export async function renewLease(
  admin: SupabaseClient,
  jobId: string,
  token: string,
): Promise<boolean> {
  return await callBoolean(admin, 'fn_renew_job_lease', {
    p_job: jobId,
    p_token: token,
  });
}

export async function releaseJob(
  admin: SupabaseClient,
  jobId: string,
  token: string,
  opts: ReleaseOptions,
): Promise<boolean> {
  return await callBoolean(admin, 'fn_release_job', {
    p_job: jobId,
    p_token: token,
    p_state: opts.state,
    p_provider_ref: opts.providerRef ?? null,
    p_delay_seconds: Math.max(0, Math.round(opts.delaySeconds ?? 0)),
    p_error: opts.error ?? null,
  });
}

/** ready -> submitting. False means someone else owns this job now. */
export async function beginSubmit(
  admin: SupabaseClient,
  jobId: string,
  token: string,
): Promise<boolean> {
  return await callBoolean(admin, 'fn_begin_submit', { p_job: jobId, p_token: token });
}

export async function recordProviderRef(
  admin: SupabaseClient,
  jobId: string,
  token: string,
  providerRef: string,
): Promise<boolean> {
  return await callBoolean(admin, 'fn_record_provider_ref', {
    p_job: jobId,
    p_token: token,
    p_ref: providerRef,
  });
}

export async function countPoll(
  admin: SupabaseClient,
  jobId: string,
  token: string,
): Promise<boolean> {
  return await callBoolean(admin, 'fn_count_poll', { p_job: jobId, p_token: token });
}

const MIN_BACKOFF_S = 1;
const MAX_BACKOFF_S = 300;

/**
 * Exponential with jitter, bounded at five minutes. A provider's own
 * Retry-After wins when it gave one — it knows more than we do — but it is
 * still clamped, because a header is an input.
 */
export function backoffSeconds(attempt: number, retryAfterSeconds?: number): number {
  const advised = Number(retryAfterSeconds);
  if (Number.isFinite(advised) && advised > 0) {
    return Math.min(MAX_BACKOFF_S, Math.max(MIN_BACKOFF_S, Math.round(advised)));
  }
  const base = Math.min(MAX_BACKOFF_S, 2 ** Math.max(0, attempt));
  const jitter = Math.random() * base * 0.25;
  return Math.min(MAX_BACKOFF_S, Math.max(MIN_BACKOFF_S, Math.round(base + jitter)));
}

async function callBoolean(
  admin: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await admin.rpc(fn, args);
  // An RPC whose result we do not know has not happened. Reporting it as a
  // success would let the caller act as though it still held the lease.
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data === true;
}
