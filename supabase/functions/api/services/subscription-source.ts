// Which payment rail pays for a user's `subscriptions` row. GET /profile
// publishes it as `subscriptionSource` so web and mobile know who manages the
// plan.
//
// There is one row per user and both rails write it. fn_apply_fulfillment
// keeps the other rail's id (coalesce), and neither id is ever cleared, so a
// row can carry both. Then the grants decide: only a grant that actually
// changed the row counts (result.applied, not a refund, not refunded since),
// and among those the one paying for the latest period wins.
//
// A row with neither id, and any owner row, reads as "stripe": it is never an
// App Store plan, and the contract has no third value.
//
// The Stripe routes use appStoreOnly(), not the source: a row with a Stripe
// subscription id lets Stripe answer, so a user who is billed twice can
// always cancel the Stripe side.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type SubscriptionSource = "stripe" | "app_store";

export interface RailRow {
  plan?: string | null;
  stripe_subscription_id?: string | null;
  iap_original_transaction_id?: string | null;
}

/** billing_transactions.source of the grant paying for the latest period. */
export type GrantRail = "stripe" | "apple" | null;

/** The billing_transactions columns the rail is judged from. */
export interface GrantRow {
  source: string;
  business_txn_id: string;
  period_end: string | null;
  applied_at: string;
  result: { applied?: boolean } | null;
}

const REFUND_PREFIX = "refund:";
/** Plenty for one user's recent subscription history. */
const GRANT_WINDOW = 50;

export function railOf(
  row: RailRow | null | undefined,
  latestGrant: GrantRail,
): SubscriptionSource | null {
  if (!row) return null;
  if (row.plan === "owner") return "stripe";
  if (!row.iap_original_transaction_id) return "stripe";
  if (!row.stripe_subscription_id) return "app_store";
  return latestGrant === "apple" ? "app_store" : "stripe";
}

/** Only the App Store ever billed this row: nothing in Stripe to manage. */
export function appStoreOnly(row: RailRow | null | undefined): boolean {
  if (!row || row.stripe_subscription_id) return false;
  return railOf(row, null) === "app_store";
}

function isRefund(g: GrantRow): boolean {
  return g.business_txn_id.startsWith(REFUND_PREFIX);
}

function timeOf(iso: string | null): number {
  return iso ? new Date(iso).getTime() : Number.NEGATIVE_INFINITY;
}

/** Newest first; -Infinity - -Infinity is NaN, so equal times compare as 0. */
function newerFirst(a: string | null, b: string | null): number {
  const diff = timeOf(b) - timeOf(a);
  return Number.isNaN(diff) ? 0 : diff;
}

/**
 * The rail of the successful, current grant. Excluded: rows fn_apply_fulfillment
 * recorded without applying (stale_period, legacy_ledger_ref), Apple refund
 * rows (`refund:<tx>`), and any grant a refund row has since reversed. The
 * latest period_end wins; applied_at breaks a tie.
 */
export function currentGrantRail(grants: GrantRow[]): GrantRail {
  const refunded = new Set(
    grants.filter(isRefund).map((g) =>
      `${g.source}:${g.business_txn_id.slice(REFUND_PREFIX.length)}`
    ),
  );
  const paying = grants
    .filter((g) => g.result?.applied === true)
    .filter((g) => !isRefund(g))
    .filter((g) => !refunded.has(`${g.source}:${g.business_txn_id}`))
    .sort((a, b) =>
      newerFirst(a.period_end, b.period_end) ||
      newerFirst(a.applied_at, b.applied_at)
    );
  const source = paying[0]?.source;
  if (source === "stripe" || source === "apple") return source;
  return null;
}

/** Reads billing_transactions only for a row both rails have written. */
export async function subscriptionSourceOf(
  admin: SupabaseClient,
  userId: string,
  row: RailRow | null | undefined,
): Promise<SubscriptionSource | null> {
  const bothRails = !!row?.iap_original_transaction_id && !!row?.stripe_subscription_id;
  if (!bothRails || row?.plan === "owner") return railOf(row, null);
  const { data, error } = await admin
    .from("billing_transactions")
    .select("source, business_txn_id, period_end, applied_at, result")
    .eq("user_id", userId)
    .eq("kind", "subscription_grant")
    .order("applied_at", { ascending: false })
    .limit(GRANT_WINDOW);
  if (error) throw new Error(`subscription_source_failed ${error.message}`);
  return railOf(row, currentGrantRail((data ?? []) as GrantRow[]));
}

/** True once any App Store subscription reached the row; the id is never cleared. */
export function appStoreEverRecorded(row: RailRow | null | undefined): boolean {
  return !!row?.iap_original_transaction_id;
}
