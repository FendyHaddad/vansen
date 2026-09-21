// Removing the bytes, exactly and provably.
//
// Two rules hold this file together, and both come from defects in the code
// it replaces:
//
//   1. **A locator is (backend, bucket, path).** `storageFor('supabase')`
//      hardcodes the `media` bucket, so deleting an upload through it either
//      did nothing or removed the identically-named media object. Nothing
//      here deletes by path alone.
//   2. **"Gone" must be observed, never assumed.** A delete call that returns
//      without error is not evidence; the object is looked up again
//      afterwards. A lookup that FAILS is a failure, not an absence — the one
//      substitution that would let the worker tick off objects it never
//      removed.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { ObjectRef, StorageAdapter } from './types.ts';

export type { ObjectRef } from './types.ts';

export interface DeleteDeps {
  admin: SupabaseClient;
  /** The single R2 bucket this deployment writes to. */
  r2Bucket: string;
  r2: StorageAdapter;
}

export interface ClaimedDeletion {
  id: string;
  object_id: string | null;
  backend: string;
  bucket: string;
  object_path: string;
  reason: string;
  attempts: number;
  lease_token: string;
}

export interface DrainSummary {
  claimed: number;
  deleted: number;
  retried: number;
  deadLettered: number;
  stale: number;
}

const DEFAULT_LIMIT = 25;

/**
 * The lease is two minutes (`fn_claim_deletions`). A backend call is given
 * well under that, so a worker that hangs loses its claim rather than coming
 * back later to acknowledge work another worker has since redone.
 */
const CALL_TIMEOUT_MS = 20_000;

export async function deleteObject(deps: DeleteDeps, ref: ObjectRef): Promise<void> {
  assertLocator(deps, ref);
  if (ref.backend === 'r2') return await deps.r2.delete(ref.path);
  const { error } = await deps.admin.storage.from(ref.bucket).remove([ref.path]);
  if (error) throw new Error(`object_delete_failed: ${error.message}`);
}

/**
 * Is the object still there? Throws when the backend will not answer.
 *
 * Supabase has no per-object HEAD on the service client, so the listing is
 * asked for this one key in this one prefix — not a prefix scan whose
 * emptiness could mean a dozen other things.
 */
export async function objectExists(deps: DeleteDeps, ref: ObjectRef): Promise<boolean> {
  assertLocator(deps, ref);
  if (ref.backend === 'r2') {
    if (!deps.r2.exists) throw new Error('exists_unsupported');
    return await deps.r2.exists(ref.path);
  }
  const cut = ref.path.lastIndexOf('/');
  const prefix = cut === -1 ? '' : ref.path.slice(0, cut);
  const name = cut === -1 ? ref.path : ref.path.slice(cut + 1);
  const { data, error } = await deps.admin.storage
    .from(ref.bucket)
    .list(prefix, { limit: 100, search: name });
  if (error) throw new Error(`object_lookup_failed: ${error.message}`);
  if (!data) throw new Error('object_lookup_failed: no listing returned');
  // `search` is a substring match, so the exact name still has to be found.
  return data.some((entry: { name: string }) => entry.name === name);
}

/**
 * One tick of the cleanup worker: claim, delete, prove, acknowledge.
 *
 * Nothing is ever dropped. A failure is handed back to `fn_complete_deletion`
 * with its error, which backs the row off and dead-letters it loudly once the
 * D2 budget is spent — the row stays queryable either way.
 */
export async function drainDeletions(
  deps: DeleteDeps,
  limit = DEFAULT_LIMIT,
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    claimed: 0,
    deleted: 0,
    retried: 0,
    deadLettered: 0,
    stale: 0,
  };
  const { data, error } = await deps.admin.rpc('fn_claim_deletions', { p_limit: limit });
  if (error) throw new Error(`claim_deletions_failed: ${error.message}`);
  const claimed = (data ?? []) as ClaimedDeletion[];
  summary.claimed = claimed.length;

  for (const row of claimed) {
    const outcome = await settleOne(deps, row);
    if (outcome === 'gone') summary.deleted += 1;
    if (outcome === 'retry') summary.retried += 1;
    if (outcome === 'dead_letter') summary.deadLettered += 1;
    if (outcome === 'stale') summary.stale += 1;
  }
  return summary;
}

type Outcome = 'gone' | 'retry' | 'dead_letter' | 'stale';

async function settleOne(deps: DeleteDeps, row: ClaimedDeletion): Promise<Outcome> {
  const ref: ObjectRef = {
    backend: row.backend as ObjectRef['backend'],
    bucket: row.bucket,
    path: row.object_path,
  };
  const failure = await removeAndVerify(deps, ref);
  if (failure) {
    console.error('deletion_failed', row.id, ref.bucket, failure.slice(0, 200));
    return await acknowledge(deps, row, failure);
  }
  return await acknowledge(deps, row, null);
}

/** Returns null when the object is observably gone, else the reason it is not. */
async function removeAndVerify(deps: DeleteDeps, ref: ObjectRef): Promise<string | null> {
  try {
    await withTimeout(deleteObject(deps, ref), 'delete_timeout');
  } catch (e) {
    // A delete that threw may still have landed; the check below decides.
    const why = String(e).slice(0, 300);
    const gone = await stillThere(deps, ref);
    if (gone === false) return null;
    return why;
  }
  const present = await stillThere(deps, ref);
  if (present === false) return null;
  if (present === true) return 'object_still_present';
  return 'object_lookup_failed';
}

/** true/false when the backend answered; null when it would not. */
async function stillThere(deps: DeleteDeps, ref: ObjectRef): Promise<boolean | null> {
  try {
    return await withTimeout(objectExists(deps, ref), 'lookup_timeout');
  } catch (e) {
    console.error('deletion_verify_failed', ref.bucket, ref.path, String(e).slice(0, 200));
    return null;
  }
}

async function acknowledge(
  deps: DeleteDeps,
  row: ClaimedDeletion,
  failure: string | null,
): Promise<Outcome> {
  const { data, error } = await deps.admin.rpc('fn_complete_deletion', {
    p_id: row.id,
    p_token: row.lease_token,
    p_error: failure,
  });
  if (error) {
    // The lease will expire and another tick will redo this object. Writing
    // it off here is the one thing we must not do.
    console.error('deletion_ack_failed', row.id, error.message);
    return 'retry';
  }
  const result = (data ?? {}) as { acknowledged?: boolean; state?: string };
  if (result.acknowledged !== true) {
    console.error('deletion_ack_stale', row.id);
    return 'stale';
  }
  if (result.state === 'dead_letter') {
    console.error('deletion_dead_letter', row.id, row.bucket, row.object_path);
    return 'dead_letter';
  }
  if (result.state === 'gone') return 'gone';
  return 'retry';
}

function assertLocator(deps: DeleteDeps, ref: ObjectRef): void {
  if (!ref.bucket || !ref.path) throw new Error('invalid_object_locator');
  if (ref.backend !== 'r2' && ref.backend !== 'supabase') {
    throw new Error('invalid_object_locator');
  }
  // An R2 row naming a bucket this deployment does not write to is a bad
  // locator, not an object to delete from the one bucket we do have.
  if (ref.backend === 'r2' && ref.bucket !== deps.r2Bucket) {
    throw new Error('unknown_r2_bucket');
  }
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), CALL_TIMEOUT_MS);
  });
  return Promise.race([work, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
}
