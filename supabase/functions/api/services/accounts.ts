// Per-user account reads the routes gate on: suspension, a model's kill
// switch and plan floor, credit balances, the Stripe customer, the active
// plan and the rail that wrote the subscription. createAccounts(admin,
// stripe) returns them; none cache.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";
import { isEntitled } from "./entitlement.ts";
import {
  appStoreOnly,
  type SubscriptionSource,
  subscriptionSourceOf,
} from "./subscription-source.ts";

export interface SubscriptionRail {
  source: SubscriptionSource | null;
  appStoreOnly: boolean;
}

const SUSPEND_STRIKES = 2;

export function createAccounts(admin: SupabaseClient, stripe: Stripe) {
  async function isSuspended(userId: string): Promise<boolean> {
    const { data } = await admin.from("profiles").select("strikes").eq(
      "id",
      userId,
    ).single();
    return (data?.strikes ?? 0) >= SUSPEND_STRIKES;
  }

  async function modelGate(
    familyId: string,
  ): Promise<{ enabled: boolean; minPlan: string }> {
    const { data } = await admin
      .from("models")
      .select("enabled,min_plan")
      .eq("id", familyId)
      .maybeSingle();
    return {
      enabled: data?.enabled ?? false,
      minPlan: data?.min_plan ?? "studio",
    };
  }

  async function creditsOf(
    userId: string,
  ): Promise<{ plan: number; pack: number }> {
    const { data, error } = await admin.rpc("fn_balances", { p_user: userId });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { plan: row?.plan_credits ?? 0, pack: row?.pack_credits ?? 0 };
  }

  async function stripeCustomerFor(
    userId: string,
    email: string,
  ): Promise<string> {
    const { data: profile } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();
    if (profile?.stripe_customer_id) return profile.stripe_customer_id;
    const customer = await stripe.customers.create({
      email,
      metadata: { user_id: userId },
    });
    await admin.from("profiles").update({ stripe_customer_id: customer.id }).eq(
      "id",
      userId,
    );
    return customer.id;
  }

  /** Highest active plan, or null. canceled = works until period end. */
  async function activePlan(
    userId: string,
  ): Promise<"studio" | "pro" | "owner" | null> {
    const { data } = await admin
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    if (!isEntitled(data, Date.now())) return null;
    return data.plan as "studio" | "pro" | "owner";
  }

  /**
   * Who bills the subscription row. `source` is what /profile publishes;
   * `appStoreOnly` is true when the row has no Stripe subscription id, and only
   * then may a Stripe route refuse without asking Stripe. A failed read
   * throws, so a caller in a try block refuses rather than guesses.
   */
  async function subscriptionRail(userId: string): Promise<SubscriptionRail> {
    const { data, error } = await admin
      .from("subscriptions")
      .select("plan, stripe_subscription_id, iap_original_transaction_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`subscription_read_failed ${error.message}`);
    return {
      source: await subscriptionSourceOf(admin, userId, data),
      appStoreOnly: appStoreOnly(data),
    };
  }

  return {
    isSuspended,
    modelGate,
    creditsOf,
    stripeCustomerFor,
    activePlan,
    subscriptionRail,
  };
}
