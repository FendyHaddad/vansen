// Account closure, shared by DELETE /profile and the underage branch of
// POST /profile/age. deleteAccount() reconciles Stripe (cancelling anything
// that can still bill), records Apple subscriptions, calls fn_delete_account,
// then removes the auth user and evicts the user from the age-gate memo.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";
import type { ErrCtx, LogError } from "../lib/errors.ts";
import { fail } from "../lib/http.ts";

/** One subscription, as it actually stood when the closure was recorded. */
interface ClosureSubscription {
  source: "stripe" | "apple";
  id: string;
  status: string;
  action: "cancelled" | "already_final" | "manage_in_app_store";
  checkedAt: string;
}

/**
 * Stripe statuses that bill nothing and never will again. Everything else —
 * active, trialing, past_due, unpaid, incomplete, paused — can still take
 * money, so it is cancelled rather than assumed harmless. The old code
 * looked only at `status: "active"` and left the rest collecting.
 */
const FINAL_STRIPE_STATUSES = new Set(["canceled", "incomplete_expired"]);

export function createAccountClosure(closureDeps: {
  admin: SupabaseClient;
  stripe: Stripe;
  logError: LogError;
  ageOkMemo: Set<string>;
}) {
  const { admin, stripe, logError, ageOkMemo } = closureDeps;

  /**
   * Establish, from the provider, what every subscription is doing — and stop
   * the ones we are able to stop.
   *
   * Throws on an operational failure: a closure recorded against a Stripe we
   * could not reach would claim a reconciliation that never happened.
   */
  async function reconcileStripeSubscriptions(
    customerId: string,
  ): Promise<ClosureSubscription[]> {
    const listed = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
    });
    const out: ClosureSubscription[] = [];
    for (const sub of listed.data) {
      const checkedAt = new Date().toISOString();
      if (FINAL_STRIPE_STATUSES.has(sub.status)) {
        out.push({
          source: "stripe",
          id: sub.id,
          status: sub.status,
          action: "already_final",
          checkedAt,
        });
        continue;
      }
      const cancelled = await stripe.subscriptions.cancel(sub.id);
      out.push({
        source: "stripe",
        id: sub.id,
        status: cancelled.status,
        action: "cancelled",
        checkedAt,
      });
    }
    return out;
  }

  /**
   * Apple subscriptions cannot be cancelled by us. Verifying a transaction
   * proves what the customer is entitled to; it grants no power to end the
   * purchase, which lives in their App Store account. We record the
   * entitlement against the closure and tell them the one action that works.
   */
  async function appleSubscriptionOf(
    userId: string,
  ): Promise<ClosureSubscription | null> {
    const { data } = await admin
      .from("subscriptions")
      .select("iap_original_transaction_id,status")
      .eq("user_id", userId)
      .maybeSingle();
    const id = data?.iap_original_transaction_id as string | undefined;
    if (!id) return null;
    return {
      source: "apple",
      id,
      status: String(data?.status ?? "unknown"),
      action: "manage_in_app_store",
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Request closure. Returns an error Response on failure, or the closure
   * result. Shared by DELETE /profile and the underage branch of
   * POST /profile/age.
   *
   * Nothing here deletes anything directly any more. The RPC hides the
   * content, cancels what can be cancelled, queues every locator and
   * anonymises what D2 keeps; the cleanup worker finishes the parts that need
   * an HTTP call. A closure is reported "completed" only when it is.
   */
  async function deleteAccount(
    c: ErrCtx & { json: (b: unknown, s: number) => Response },
    userId: string,
  ): Promise<{ error: Response } | { result: Record<string, unknown> }> {
    const { data: prof } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    const subscriptions: ClosureSubscription[] = [];
    if (prof?.stripe_customer_id) {
      try {
        subscriptions.push(
          ...await reconcileStripeSubscriptions(prof.stripe_customer_id),
        );
      } catch (e) {
        // An unreconciled subscription is the one thing worth stopping for:
        // closing the account around a live one would keep charging a
        // customer who no longer has an account to show for it.
        logError(c, "delete_failed", e);
        return {
          error: fail(
            c,
            503,
            "delete_failed",
            "Could not confirm your subscription is cancelled — try again",
          ),
        };
      }
    }
    const apple = await appleSubscriptionOf(userId);
    if (apple) subscriptions.push(apple);

    const { data, error } = await admin.rpc("fn_delete_account", {
      p_user: userId,
      p_subscriptions: subscriptions,
    });
    if (error) {
      logError(c, "delete_failed", error);
      return {
        error: fail(c, 503, "delete_failed", "Could not delete — try again"),
      };
    }
    const closure = (data ?? {}) as Record<string, unknown>;
    await finishClosure(c, closure);
    ageOkMemo.delete(userId);
    return {
      result: {
        ...closure,
        subscriptions,
        // The only honest thing to say about an Apple subscription.
        appleAction: apple ? "manage_in_app_store" : null,
      },
    };
  }

  /**
   * Remove the auth user as soon as the data side is finalised, so a closed
   * account cannot sign in while the worker's next tick is pending. A failure
   * is not fatal: the same work is queued, and the cleanup worker retries it.
   */
  async function finishClosure(
    c: ErrCtx,
    closure: Record<string, unknown>,
  ): Promise<void> {
    const authUserId = closure.authUserId as string | undefined;
    if (!authUserId) return;
    const { error } = await admin.auth.admin.deleteUser(authUserId);
    if (error && !/not.?found/i.test(error.message)) {
      logError(c, "auth_delete_deferred", error);
      return;
    }
    const { error: completeError } = await admin.rpc(
      "fn_complete_account_deletion",
      { p_request: closure.requestId },
    );
    if (completeError) logError(c, "closure_complete_deferred", completeError);
  }

  return { deleteAccount };
}
