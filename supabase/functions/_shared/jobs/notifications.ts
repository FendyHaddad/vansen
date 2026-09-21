// Draining the notification outbox.
//
// Settlement writes a row; delivery happens here, later, on its own schedule.
// That split is what stops a push failure from failing a paid request, and it
// is why "did the customer get told" is answerable from the database instead of
// from whichever request happened to be open at the time.
//
// Delivery to FCM is AT LEAST ONCE: a crash between the send and the ack
// repeats the push. Every message therefore carries its outbox row id and
// clients must deduplicate on it. The database side is exactly once.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { ServiceAccount } from '../push.ts';
import type { sendGenerationPush } from '../push.ts';

/** Leases last 2 minutes (see fn_claim_notifications); stop well before that. */
const LEASE_BUDGET_MS = 90_000;
const SEND_TIMEOUT_MS = 20_000;

export interface NotificationDeps {
  admin: SupabaseClient;
  account: ServiceAccount | null;
  sendPush: typeof sendGenerationPush;
  now?: () => number;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  failed: number;
  /** Rows whose lease was left to expire because the budget ran out. */
  abandoned: number;
}

interface OutboxRow {
  id: string;
  user_id: string;
  generation_id: string | null;
  event: 'generation_done' | 'generation_failed';
  lease_token: string;
}

export async function drainNotifications(
  deps: NotificationDeps,
  limit = 20,
): Promise<DrainSummary> {
  const clock = deps.now ?? (() => Date.now());
  const startedAt = clock();
  const summary: DrainSummary = { claimed: 0, sent: 0, failed: 0, abandoned: 0 };

  const { data, error } = await deps.admin.rpc('fn_claim_notifications', {
    p_limit: limit,
  });
  if (error) throw new Error(`fn_claim_notifications: ${error.message}`);

  const rows = (data ?? []) as OutboxRow[];
  summary.claimed = rows.length;
  for (const row of rows) {
    // Never still be working when the lease expires: another drainer would
    // already have claimed the row and we would both send.
    if (clock() - startedAt > LEASE_BUDGET_MS) {
      summary.abandoned += 1;
      continue;
    }
    const failure = await deliver(deps, row);
    await ack(deps, row, failure);
    if (failure) summary.failed += 1;
    if (!failure) summary.sent += 1;
  }
  return summary;
}

/** Returns null on success, or a short, safe error code. */
async function deliver(
  deps: NotificationDeps,
  row: OutboxRow,
): Promise<string | null> {
  // Not "delivered to nobody": a missing service account is a configuration
  // fault someone has to fix, and it must stay visible in last_error.
  if (!deps.account) return 'push_not_configured';

  const { data: devices, error } = await deps.admin
    .from('devices')
    .select('token')
    .eq('user_id', row.user_id);
  if (error) return 'device_lookup_failed';

  const tokens = (devices ?? []).map((d) => String(d.token));
  // A user with no devices is a completed notification, not a failure — there
  // is nothing to retry and retrying forever would never dead-letter.
  if (tokens.length === 0) return null;

  let stale: string[];
  try {
    stale = await withTimeout(
      deps.sendPush(deps.account, tokens, {
        type: row.event,
        generationId: row.generation_id ?? '',
        notificationId: row.id,
      }),
      SEND_TIMEOUT_MS,
    );
  } catch (e) {
    console.error('push_send_failed', row.id, String(e).slice(0, 200));
    return 'push_send_failed';
  }
  if (stale.length === 0) return null;
  await dropStaleTokens(deps, row.user_id, stale);
  return null;
}

async function dropStaleTokens(
  deps: NotificationDeps,
  userId: string,
  stale: string[],
): Promise<void> {
  const { error } = await deps.admin
    .from('devices')
    .delete()
    .eq('user_id', userId)
    .in('token', stale);
  if (!error) return;
  // The push itself succeeded; a failed cleanup is not a failed delivery.
  console.error('stale_token_cleanup_failed', userId, error.message);
}

async function ack(
  deps: NotificationDeps,
  row: OutboxRow,
  failure: string | null,
): Promise<void> {
  const { error } = await deps.admin.rpc('fn_ack_notification', {
    p_id: row.id,
    p_token: row.lease_token,
    p_error: failure,
  });
  if (!error) return;
  // The lease expires on its own; the row will be picked up again. Repeating
  // a push is allowed, which is exactly why the id is in the payload.
  console.error('notification_ack_failed', row.id, error.message);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('push_timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
