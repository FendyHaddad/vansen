// Stripe checkout starts: POST /billing/subscribe and POST /billing/pack.
// Both refuse on iOS storefronts where Apple requires an in-app purchase
// (requireWebLane). Stripe, not our mirror, decides "already subscribed".
import type { Context } from "jsr:@hono/hono";
import { CREDIT_PACKS, packCredits } from "../_shared/model-families.ts";
import { laneFor } from "../_shared/billing-lanes.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { clientOf, fail } from "../lib/http.ts";

export function registerBillingCheckoutRoutes(app: App, ctx: ApiContext): void {
  const {
    admin,
    stripe,
    activePlan,
    stripeCustomerFor,
    checkoutReturnUrls,
    logError,
    PLAN_PRICE_IDS,
    LAUNCH_COUPON_ID,
  } = ctx;

  /** Stripe checkout is only allowed where the storefront's rules permit it.
   * An unknown platform or a missing storefront is NOT Android/US — a wrong
   * guess here sells a subscription Apple requires to be an in-app purchase. */
  function requireWebLane(c: Context): Response | null {
    const client = clientOf(c);
    if (client !== "ios") return null;
    const storefront = (c.req.header("x-vansen-storefront") ?? "").toUpperCase();
    const lane = laneFor("ios", storefront, Deno.env.get("LANE_B") === "on");
    if (lane === "A") return null;
    return fail(
      c,
      403,
      "lane_not_allowed",
      "Purchases on this device go through the App Store.",
    );
  }

  app.post("/billing/subscribe", async (c) => {
    const laneBlocked = requireWebLane(c);
    if (laneBlocked) return laneBlocked;
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const plan = body.plan === "pro"
      ? "pro"
      : body.plan === "studio"
      ? "studio"
      : null;
    if (!plan) {
      return fail(c, 400, "invalid_plan", "plan must be studio or pro");
    }
    const { data: ownSub } = await admin
      .from("subscriptions")
      .select("plan, status, stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (ownSub?.plan === "owner" && ownSub.status === "active") {
      return fail(
        c,
        400,
        "owner_plan",
        "Owner accounts have unlimited credits",
      );
    }
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      // Ask Stripe, not our mirror. The `subscriptions` table is written only by the
      // webhook, so it lags (or, if the webhook failed, never arrives) and it holds one
      // row per user — a second subscription would overwrite the first and bill twice
      // with nothing to show for it. Stripe Checkout does not dedupe subscriptions
      // itself, so this is the only thing standing between a double click and a
      // double charge.
      const history = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      // "Billing" is wider than our 'active': past_due/unpaid are still in dunning, and
      // a cancel_at_period_end sub is plain `active` here — it charges until it lapses.
      const billing = history.data.filter((s) =>
        s.status === "active" || s.status === "trialing" ||
        s.status === "past_due" || s.status === "unpaid"
      );
      if (billing.length > 0) {
        return fail(
          c,
          400,
          "already_subscribed",
          "Use the billing portal to change plans",
        );
      }
      // Launch promo: first-time subscribers only. Keyed off Stripe's full history
      // rather than the mirror, so a missing row cannot hand out the coupon twice.
      const firstTime = history.data.length === 0;
      const returns = checkoutReturnUrls(c, body);
      const session = await stripe.checkout.sessions.create({
        customer,
        mode: "subscription",
        line_items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
        discounts: firstTime && LAUNCH_COUPON_ID
          ? [{ coupon: LAUNCH_COUPON_ID }]
          : undefined,
        success_url: returns.success,
        cancel_url: returns.cancel,
        metadata: { user_id: userId, plan },
        subscription_data: { metadata: { user_id: userId, plan } },
      });
      return c.json({ url: session.url });
    } catch (e) {
      logError(c, "subscribe_failed", e);
      return fail(c, 400, "billing_failed", "Could not start checkout");
    }
  });

  app.post("/billing/pack", async (c) => {
    const laneBlocked = requireWebLane(c);
    if (laneBlocked) return laneBlocked;
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const usd = Number(body.usd);
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "subscription_required",
        "Packs are for active subscribers.",
      );
    }
    if (plan === "owner") {
      return fail(
        c,
        400,
        "owner_plan",
        "Owner accounts have unlimited credits",
      );
    }
    if (!CREDIT_PACKS.some((p) => p.usd === usd)) {
      return fail(
        c,
        400,
        "invalid_amount",
        `usd must be one of ${CREDIT_PACKS.map((p) => p.usd).join(", ")}`,
      );
    }
    const credits = packCredits(usd, plan);
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const returns = checkoutReturnUrls(c, body);
      const session = await stripe.checkout.sessions.create({
        customer,
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Vansen credit pack — ${credits.toLocaleString()} credits`,
            },
            unit_amount: usd * 100,
          },
          quantity: 1,
        }],
        success_url: returns.success,
        cancel_url: returns.cancel,
        metadata: {
          user_id: userId,
          pack_usd: String(usd),
          // The rate in force at purchase time. The webhook recomputes the
          // grant from (pack_usd, pack_plan) through the catalog; pack_credits
          // is display/audit only and is never consumed as a grant.
          pack_plan: plan,
          pack_credits: String(credits),
        },
      });
      return c.json({ url: session.url });
    } catch (e) {
      logError(c, "pack_failed", e);
      return fail(c, 400, "billing_failed", "Could not start checkout");
    }
  });
}
