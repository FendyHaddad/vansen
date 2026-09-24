// Which payment rail wrote a user's `subscriptions` row. GET /profile
// publishes it as `subscriptionSource` so web and mobile know who manages the
// plan; the Stripe billing routes refuse to act on an App Store row.
//
// There is one row per user and both rails write it. fn_apply_fulfillment
// keeps the other rail's id (coalesce), so a row can carry both ids. Then the
// rail of the latest subscription grant in billing_transactions decides.
// A row with neither id (an owner grant) reads as "stripe": it is never an
// App Store plan, and the contract has no third value.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type SubscriptionSource = "stripe" | "app_store";

export interface RailRow {
  stripe_subscription_id?: string | null;
  iap_original_transaction_id?: string | null;
}

/** billing_transactions.source of the user's latest subscription grant. */
export type GrantRail = "stripe" | "apple" | null;

export function railOf(
  row: RailRow | null | undefined,
  latestGrant: GrantRail,
): SubscriptionSource | null {
  if (!row) return null;
  if (!row.iap_original_transaction_id) return "stripe";
  if (!row.stripe_subscription_id) return "app_store";
  return latestGrant === "apple" ? "app_store" : "stripe";
}

/** Reads billing_transactions only for a row both rails have written. */
export async function subscriptionSourceOf(
  admin: SupabaseClient,
  userId: string,
  row: RailRow | null | undefined,
): Promise<SubscriptionSource | null> {
  const bothRails = !!row?.iap_original_transaction_id && !!row?.stripe_subscription_id;
  if (!bothRails) return railOf(row, null);
  const { data, error } = await admin
    .from("billing_transactions")
    .select("source")
    .eq("user_id", userId)
    .eq("kind", "subscription_grant")
    .order("applied_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`subscription_source_failed ${error.message}`);
  return railOf(row, (data?.source as GrantRail) ?? null);
}

/** True once any App Store subscription reached the row; the id is never cleared. */
export function appStoreEverRecorded(row: RailRow | null | undefined): boolean {
  return !!row?.iap_original_transaction_id;
}
