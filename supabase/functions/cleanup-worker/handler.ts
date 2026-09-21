// One tick of the cleanup worker.
//
// It finishes what the database can only ask for. Postgres can tombstone a
// row, queue a locator and anonymise a ledger entry inside a transaction; it
// cannot remove an object from R2 or delete an auth user. Both of those are
// HTTP calls that may fail halfway, so both are driven from here, under a
// lease, against a queue that keeps the work until it is observably done.
//
// The tick is bounded and idempotent. Anything it does not finish is still
// queued, still backed off, and still there for the next one.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  type DeleteDeps,
  drainDeletions,
  type DrainSummary,
} from './_shared/storage/deletion-service.ts';

export interface CleanupDeps {
  admin: SupabaseClient;
  objects: Omit<DeleteDeps, 'admin'>;
  /**
   * Removes the auth user. Resolves only when the user is gone; a rejection
   * leaves the closure open, which is the honest outcome.
   */
  deleteAuthUser(userId: string): Promise<void>;
  /** Shared secret the scheduler presents. Never optional in production. */
  workerSecret: string | null;
  objectLimit?: number;
  closureLimit?: number;
}

export interface CleanupSummary extends DrainSummary {
  closuresCompleted: number;
  closuresPending: number;
}

const DEFAULT_OBJECT_LIMIT = 50;
const DEFAULT_CLOSURE_LIMIT = 20;

export function createCleanupWorker(
  deps: CleanupDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method !== 'POST') {
      return json({ error: { code: 'method_not_allowed' } }, 405);
    }
    // A missing secret is a misconfiguration, not an open door. This worker
    // deletes things; it fails closed.
    if (!deps.workerSecret) {
      console.error('cleanup_secret_missing');
      return json({ error: { code: 'unauthorized' } }, 401);
    }
    if (req.headers.get('x-worker-secret') !== deps.workerSecret) {
      return json({ error: { code: 'unauthorized' } }, 401);
    }
    const summary = await runCleanupTick(deps);
    return json(summary, 200);
  };
}

export async function runCleanupTick(deps: CleanupDeps): Promise<CleanupSummary> {
  const objects = await drainDeletions(
    { ...deps.objects, admin: deps.admin },
    deps.objectLimit ?? DEFAULT_OBJECT_LIMIT,
  ).catch((e) => {
    console.error('cleanup_drain_failed', String(e).slice(0, 300));
    return { claimed: 0, deleted: 0, retried: 0, deadLettered: 0, stale: 0 };
  });

  const closures = await finishClosures(deps);
  return { ...objects, ...closures };
}

/**
 * The last step of an account closure: the data side is already finalised, so
 * all that is left is the auth user, which only an admin API call can remove.
 *
 * `fn_complete_account_deletion` decides whether the closure is actually
 * finished — a provider still holding a derived model keeps it open — so this
 * function never writes 'completed' itself.
 */
async function finishClosures(
  deps: CleanupDeps,
): Promise<{ closuresCompleted: number; closuresPending: number }> {
  const { data, error } = await deps.admin
    .from('account_deletions')
    .select('id, auth_user_id')
    .neq('status', 'completed')
    .not('data_finalized_at', 'is', null)
    .limit(deps.closureLimit ?? DEFAULT_CLOSURE_LIMIT);
  if (error) {
    console.error('cleanup_closures_read_failed', error.message);
    return { closuresCompleted: 0, closuresPending: 0 };
  }

  let completed = 0;
  let pending = 0;
  for (const row of (data ?? []) as { id: string; auth_user_id: string | null }[]) {
    const done = await finishOne(deps, row);
    if (done) completed += 1;
    if (!done) pending += 1;
  }
  return { closuresCompleted: completed, closuresPending: pending };
}

async function finishOne(
  deps: CleanupDeps,
  row: { id: string; auth_user_id: string | null },
): Promise<boolean> {
  if (row.auth_user_id) {
    try {
      await deps.deleteAuthUser(row.auth_user_id);
    } catch (e) {
      // The customer's own data is already gone; this is the sign-in record.
      // It stays owed rather than being written off.
      console.error('cleanup_auth_delete_failed', row.id, String(e).slice(0, 300));
      return false;
    }
  }
  const { data, error } = await deps.admin.rpc('fn_complete_account_deletion', {
    p_request: row.id,
  });
  if (error) {
    console.error('cleanup_complete_failed', row.id, error.message);
    return false;
  }
  const result = (data ?? {}) as { status?: string; reason?: string };
  if (result.status === 'completed') return true;
  console.error('cleanup_closure_open', row.id, result.reason ?? 'unknown');
  return false;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
