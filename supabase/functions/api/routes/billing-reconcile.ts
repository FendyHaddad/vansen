// Grant recovery for dropped webhooks: POST /billing/reconcile (Stripe
// packs, recomputed from the catalog) and POST /iap/verify (an App Store
// JWS). Both settle idempotently, so calling them after every purchase is safe.
import type Stripe from "npm:stripe@17";
import { CREDIT_PACKS, packCredits } from "../_shared/model-families.ts";
import { applyIapTransaction } from "../_shared/iap-grants.ts";
import { applyFulfillment } from "../_shared/billing-fulfillment.ts";
import {
  environmentOf,
  looksLikeJws,
  receiptNeverVerifies,
} from "../_shared/apple-verifier.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

/**
 * What a paid checkout session is worth, per the catalog. `pack_credits` on the
 * session metadata is deliberately ignored: the grant is recomputed from the
 * rate inputs, so a stale or tampered number can never be paid out. Returns 0
 * for anything that is not a pack we recognise.
 */
function catalogPackCredits(metadata: Stripe.Metadata | null): number {
  const usd = Number(metadata?.pack_usd);
  if (!CREDIT_PACKS.some((p) => p.usd === usd)) return 0;
  const plan = metadata?.pack_plan;
  if (plan !== "studio" && plan !== "pro") return 0;
  return packCredits(usd, plan);
}

export function registerBillingReconcileRoutes(app: App, ctx: ApiContext): void {
  const { admin, stripe, appleVerifier, creditsOf, logError } = ctx;

  /**
   * Reconcile fallback for a dropped `checkout.session.completed`: re-read the
   * caller's own paid sessions and settle any pack the webhook never landed.
   *
   * Two rules make this safe to call at any time. The grant is recomputed from
   * the catalog — the dollar size and the plan in force at purchase — so a
   * number written on the session is never paid out. And it settles through the
   * same `fn_apply_fulfillment` transaction as the webhook, keyed on the same
   * session id, so whichever path arrives second sees a replay instead of
   * granting the money twice.
   */
  app.post("/billing/reconcile", async (c) => {
    const userId = c.get("userId");
    try {
      const { data: profile } = await admin
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .single();
      if (!profile?.stripe_customer_id) {
        return c.json({ credited: 0, credits: await creditsOf(userId) });
      }
      const sessions = await stripe.checkout.sessions.list({
        customer: profile.stripe_customer_id,
        limit: 100,
      });
      let credited = 0;
      for (const s of sessions.data) {
        if (s.payment_status !== "paid") continue;
        const credits = catalogPackCredits(s.metadata);
        if (!credits) continue;
        const result = await applyFulfillment(admin, {
          source: "stripe",
          businessTxnId: String(s.id),
          userId,
          kind: "pack_grant",
          credits,
          eventAt: new Date((s.created ?? 0) * 1000).toISOString(),
        });
        if (result.applied) credited += 1;
      }
      return c.json({ credited, credits: await creditsOf(userId) });
    } catch (e) {
      logError(c, "reconcile_failed", e);
      return fail(c, 400, "billing_failed", "Reconcile failed");
    }
  });

  // Reconcile fallback for a dropped App Store notification: the client submits
  // its own purchase JWS for server-side re-validation. The appAccountToken baked
  // into the transaction must be the caller — nobody redeems another user's
  // receipt. Grants are idempotent (fn_apply_fulfillment, keyed on the Apple
  // transaction id), so calling this after every purchase is safe and doubles
  // as the instant-grant path. A sandbox receipt (App Review, TestFlight) is
  // granted too and recorded as sandbox, which keeps it out of revenue.
  app.post("/iap/verify", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const jws = typeof body.jws === "string" ? body.jws : "";
    if (!jws) return fail(c, 400, "invalid_input", "Missing jws");
    // A receipt that can never verify is final: the app finishes the
    // transaction on a 4xx. Answering 503 would leave it open forever, and
    // StoreKit then refuses every new purchase of that product.
    const rejected = () =>
      fail(
        c,
        422,
        "purchase_rejected",
        "This purchase cannot be applied to this account.",
      );
    if (!looksLikeJws(jws)) return rejected();
    try {
      const tx = await appleVerifier().verifyAndDecodeTransaction(jws);
      if (tx.appAccountToken !== userId) {
        return fail(c, 403, "forbidden", "Receipt belongs to another account");
      }
      const environment = environmentOf(tx);
      const result = await applyIapTransaction(admin, userId, {
        productId: tx.productId ?? "",
        transactionId: tx.transactionId ?? "",
        originalTransactionId: tx.originalTransactionId ?? "",
        expiresDate: tx.expiresDate,
        revocationDate: tx.revocationDate,
        environment,
      });
      console.info(JSON.stringify({
        event: "iap_verified",
        environment,
        transactionId: tx.transactionId ?? null,
        productId: tx.productId ?? null,
        outcome: result.outcome,
        rejection: result.rejection ?? null,
        requestId: c.get("requestId") ?? null,
      }));
      // The client must be able to tell "your credits are here" from "try again
      // in a moment" — a retryable failure that reads as success strands paid
      // money, and one that reads as a hard error sends the user to support.
      if (result.outcome === "rejected") return rejected();
      return c.json({
        // `granted` is kept for one release so an un-updated mobile build is
        // not broken; MT-01 moves the client to `outcome`.
        granted: true,
        outcome: result.outcome,
        credits: result.credits ?? await creditsOf(userId),
      });
    } catch (e) {
      logError(c, "iap_verify_failed", e);
      // Only a receipt that neither production nor sandbox accepts reaches
      // here as a permanent refusal; a sandbox receipt was granted above.
      if (receiptNeverVerifies(e)) return rejected();
      const res = fail(
        c,
        503,
        "retry_later",
        "We could not confirm your purchase yet. It is safe to try again.",
      );
      res.headers.set("retry-after", "10");
      return res;
    }
  });
}
