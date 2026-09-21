// The only way a generation becomes terminal.
//
// Four call sites used to do their own read-then-write: the inline finish, the
// poller, the cancel route and the stale sweep. Routing them all through one
// RPC means "exactly one terminal state, exactly one refund, exactly one
// notification outbox entry (delivery is at least once)" is a property of the
// database rather than a property of whichever code path happened to run first.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface SettlementGuard {
  expectedState?: 'pending';
  leaseToken?: string;
  failureCode?: string;
}

export interface SettleOutcome {
  settled: boolean;
  /** The status the generation already had when we lost the race. */
  previous: string | null;
  refunded: number;
}

async function settle(
  admin: SupabaseClient,
  args: Record<string, unknown>,
): Promise<SettleOutcome> {
  const { data, error } = await admin.rpc('fn_settle_job', args);
  // A settlement whose result we do not know is NOT a settlement. Swallowing
  // this is how a job gets marked done on a write that never landed.
  if (error) throw new Error(error.message);
  if (!data) throw new Error('fn_settle_job returned no result');
  return data as SettleOutcome;
}

export function settleDone(
  admin: SupabaseClient,
  jobId: string,
  media: { path: string; backend: 'supabase' | 'r2'; meta?: Record<string, unknown> },
  guard: SettlementGuard = {},
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'done',
    p_media_path: media.path,
    p_backend: media.backend,
    p_meta: media.meta ?? {},
    p_error: null,
    p_expected_state: guard.expectedState ?? 'pending',
    p_lease_token: guard.leaseToken ?? null,
  });
}

export function settleFailed(
  admin: SupabaseClient,
  jobId: string,
  error: string,
  guard: SettlementGuard = {},
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'failed',
    p_media_path: null,
    p_backend: null,
    p_meta: {},
    p_error: error.slice(0, 500),
    p_failure_code: guard.failureCode ??
      (error === 'cancelled' ? 'cancelled' : 'generation_failed'),
    p_expected_state: guard.expectedState ?? 'pending',
    p_lease_token: guard.leaseToken ?? null,
  });
}
