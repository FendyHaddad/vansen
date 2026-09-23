// Managing an existing Stripe subscription: POST /billing/change-plan,
// GET /billing/lane, GET /billing/overview, POST /billing/cancel,
// POST /billing/resume and POST /billing/portal. Credits always land via
// the webhook's invoice.paid; these routes only mirror plan and status.
import { laneFor } from "../_shared/billing-lanes.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export function registerBillingSubscriptionRoutes(
  app: App,
  ctx: ApiContext,
): void {
  const { admin, stripe, stripeCustomerFor, appOrigin, logError, PLAN_PRICE_IDS } =
    ctx;

  /**
   * Studio <-> Pro. Swaps the price on the EXISTING subscription rather than
   * cancelling and re-creating: one subscription per customer is what keeps the
   * double-billing guard in /billing/subscribe meaningful.
   *
   * when='now' restarts the billing cycle today (unused time on the old plan is
   * prorated back), so invoice.paid fires and fn_apply_fulfillment lands the new
   * grant (p_never_lower, so an upgrade tops the bucket up rather than cutting it).
   * when='period_end' books a Stripe Subscription Schedule; the swap happens at
   * renewal and that cycle's invoice.paid carries the new grant.
   *
   * Downgrades are period_end only, and that is enforced HERE rather than in the
   * dialog: an immediate downgrade makes fn_apply_fulfillment compute a negative
   * delta (1500 - 3000 = -1500) and silently delete credits the user paid Pro
   * prices for. p_never_lower guards the upgrade direction, not this one.
   */
  app.post("/billing/change-plan", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const plan = body.plan === "pro"
      ? "pro"
      : body.plan === "studio"
      ? "studio"
      : null;
    const when = body.when === "now"
      ? "now"
      : body.when === "period_end"
      ? "period_end"
      : null;
    if (!plan) {
      return fail(c, 400, "invalid_plan", "plan must be studio or pro");
    }
    if (!when) {
      return fail(c, 400, "invalid_when", "when must be now or period_end");
    }

    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(
          c,
          400,
          "no_subscription",
          "Start a subscription before changing plans",
        );
      }

      const currentPlan = sub.items.data[0]?.price?.id === PLAN_PRICE_IDS.pro
        ? "pro"
        : "studio";
      if (currentPlan === plan) {
        return fail(c, 400, "same_plan", `You are already on ${plan}`);
      }
      const downgrade = currentPlan === "pro" && plan === "studio";
      if (downgrade && when === "now") {
        return fail(
          c,
          400,
          "downgrade_at_period_end",
          "Downgrades take effect at your renewal date",
        );
      }
      // A schedule cannot ride on a subscription that is already set to stop.
      if (sub.cancel_at_period_end && when === "period_end") {
        return fail(
          c,
          400,
          "subscription_ending",
          "Resume your subscription in Billing before scheduling a change",
        );
      }

      const scheduleId = typeof sub.schedule === "string"
        ? sub.schedule
        : (sub.schedule?.id ?? null);
      if (scheduleId && when === "period_end") {
        return fail(
          c,
          400,
          "already_scheduled",
          "A plan change is already scheduled for your renewal",
        );
      }

      const itemId = sub.items.data[0]!.id;
      if (when === "now") {
        // "Start now" overrides a change booked earlier: a schedule-managed
        // subscription rejects direct updates, so hand it back to normal billing
        // before swapping the price.
        if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
        const updated = await stripe.subscriptions.update(sub.id, {
          items: [{ id: itemId, price: PLAN_PRICE_IDS[plan]! }],
          proration_behavior: "create_prorations",
          billing_cycle_anchor: "now",
          cancel_at_period_end: false,
          metadata: { user_id: userId, plan },
        });
        // Mirror the swap synchronously: the workspace reloads /profile the moment
        // this returns, and waiting for the webhook leaves it showing the old plan
        // (and its subscribe CTA) until a manual refresh. Credits still land via
        // invoice.paid — only the plan/status mirror is written here.
        const periodEndEpoch =
          (updated as { current_period_end?: number }).current_period_end ??
            (updated.items?.data?.[0] as
              | { current_period_end?: number }
              | undefined)
              ?.current_period_end;
        await admin
          .from("subscriptions")
          .update({
            plan,
            status: "active",
            stripe_subscription_id: updated.id,
            ...(periodEndEpoch
              ? {
                current_period_end: new Date(periodEndEpoch * 1000)
                  .toISOString(),
              }
              : {}),
            pending_plan: null,
            pending_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        return c.json({ plan, effectiveAt: null });
      }

      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
      });
      const current = schedule.phases[0]!;
      await stripe.subscriptionSchedules.update(schedule.id, {
        // release hands the subscription back to normal billing once the new phase
        // starts; without it the schedule would cancel the sub when it runs out.
        end_behavior: "release",
        phases: [
          {
            items: [{ price: PLAN_PRICE_IDS[currentPlan]!, quantity: 1 }],
            start_date: current.start_date,
            end_date: current.end_date,
          },
          {
            items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
            metadata: { user_id: userId, plan },
          },
        ],
        metadata: { user_id: userId, plan },
      });
      const effectiveAt = new Date(current.end_date * 1000).toISOString();
      await admin
        .from("subscriptions")
        .update({ pending_plan: plan, pending_at: effectiveAt })
        .eq("user_id", userId);
      return c.json({ plan, effectiveAt });
    } catch (e) {
      logError(c, "change_plan_failed", e);
      return fail(c, 400, "billing_failed", "Could not change your plan");
    }
  });

  app.get("/billing/lane", (c) => {
    // An unrecognised platform must not read as Android (lane A) — that would
    // open Stripe checkout to any caller that omits or misspells the value.
    const raw = c.req.query("platform");
    const platform = raw === "android" ? "android" : "ios";
    const storefront = (c.req.query("storefront") ?? "").toUpperCase();
    const laneBEnabled = Deno.env.get("LANE_B") === "on";
    return c.json({ lane: laneFor(platform, storefront, laneBEnabled) });
  });

  /**
   * One call for everything the Subscription tab shows beyond our own mirror:
   * next invoice, card on file, and whether the sub is set to stop. All read
   * straight from Stripe — the mirror only knows plan/status/period-end.
   */
  app.get("/billing/overview", async (c) => {
    const userId = c.get("userId");
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
        expand: ["data.default_payment_method"],
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return c.json({
          cancelAtPeriodEnd: false,
          upcoming: null,
          paymentMethod: null,
        });
      }

      let upcoming: { amountUsd: number; date: string | null } | null = null;
      if (!sub.cancel_at_period_end) {
        try {
          const invoice = await stripe.invoices.retrieveUpcoming({ customer });
          const epoch = invoice.next_payment_attempt ?? invoice.period_end ??
            null;
          upcoming = {
            amountUsd: Math.round(invoice.amount_due) / 100,
            date: epoch ? new Date(epoch * 1000).toISOString() : null,
          };
        } catch {
          // No upcoming invoice is a normal state, not an error.
        }
      }

      const pm = sub.default_payment_method;
      const card = pm && typeof pm !== "string" ? pm.card : null;
      return c.json({
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        upcoming,
        paymentMethod: card ? { brand: card.brand, last4: card.last4 } : null,
      });
    } catch (e) {
      logError(c, "overview_failed", e);
      return fail(c, 400, "billing_failed", "Could not load billing details");
    }
  });

  /**
   * In-app cancellation (at period end, never immediate — the user keeps what
   * they paid for). The reason is required by the UI and stored on the Stripe
   * subscription's metadata, where the dashboard shows it next to the churn.
   */
  app.post("/billing/cancel", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body.reason === "string"
      ? body.reason.slice(0, 120)
      : "";
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(
          c,
          400,
          "no_subscription",
          "No active subscription to cancel",
        );
      }
      if (sub.cancel_at_period_end) return c.json({ cancelAtPeriodEnd: true });

      // A schedule-managed sub rejects direct updates; a booked plan change dies
      // with the cancellation anyway, so release it (and its reminder) first.
      const scheduleId = typeof sub.schedule === "string"
        ? sub.schedule
        : (sub.schedule?.id ?? null);
      if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
      await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: true,
        metadata: { ...sub.metadata, cancel_reason: reason },
      });
      await admin
        .from("subscriptions")
        .update({
          status: "canceled",
          cancel_reason: reason || null,
          pending_plan: null,
          pending_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      return c.json({ cancelAtPeriodEnd: true });
    } catch (e) {
      logError(c, "cancel_failed", e);
      return fail(
        c,
        400,
        "billing_failed",
        "Could not cancel your subscription",
      );
    }
  });

  /** Undo a pending cancellation — billing continues as if nothing happened. */
  app.post("/billing/resume", async (c) => {
    const userId = c.get("userId");
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(c, 400, "no_subscription", "No subscription to resume");
      }
      if (sub.cancel_at_period_end) {
        await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: false,
        });
      }
      await admin
        .from("subscriptions")
        .update({
          status: "active",
          cancel_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      return c.json({ cancelAtPeriodEnd: false });
    } catch (e) {
      logError(c, "resume_failed", e);
      return fail(
        c,
        400,
        "billing_failed",
        "Could not resume your subscription",
      );
    }
  });

  app.post("/billing/portal", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const customer = await stripeCustomerFor(c.get("userId"), c.get("email"));
      const returnUrl = body.platform === "mobile"
        ? "vansen://billing-return?status=portal"
        : `${appOrigin(c)}/app/settings`;
      const portal = await stripe.billingPortal.sessions.create({
        customer,
        return_url: returnUrl,
      });
      return c.json({ url: portal.url });
    } catch (e) {
      logError(c, "portal_failed", e);
      return fail(c, 400, "billing_failed", "Could not open billing portal");
    }
  });
}
