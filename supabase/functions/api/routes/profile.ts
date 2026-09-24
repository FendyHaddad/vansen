// Profile, age gate, prefs and push devices: GET/PATCH/DELETE /profile,
// POST /profile/age (an underage answer closes the account), PUT /prefs and
// POST/DELETE /devices. Closure itself is services/account-closure.ts.
// GET /profile also says which rail wrote the subscription row
// (`subscriptionSource`), so both apps know who manages the plan.
import { isEntitled } from "../services/entitlement.ts";
import { railOf, subscriptionSourceOf } from "../services/subscription-source.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { sanitizePrefs } from "../lib/request-sanitize.ts";

/** Accept a strict, real, non-future, ≤120y-old YYYY-MM-DD string; else null. */
function parseBirthDate(s: unknown): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null; // e.g. 2001-02-30 rolled over
  }
  const now = Date.now();
  if (dt.getTime() > now) return null; // future
  if (now - dt.getTime() > 120 * 365.25 * 864e5) return null; // >120 years
  return s;
}

/** Whole years old today, UTC, with correct month/day rollover. */
function ageFromBirthDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const mo = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  if (mo < m || (mo === m && day < d)) age--;
  return age;
}

export function registerProfileRoutes(app: App, ctx: ApiContext): void {
  const { admin, creditsOf, deleteAccount, logError } = ctx;

  app.get("/profile", async (c) => {
    const userId = c.get("userId");
    const [{ data: profile, error }, credits, { data: subscription }] =
      await Promise.all([
        admin.from("profiles").select("*").eq("id", userId).single(),
        creditsOf(userId),
        admin.from("subscriptions").select("*").eq("user_id", userId)
          .maybeSingle(),
      ]);
    if (error || !profile) return fail(c, 404, "not_found", "Profile missing");
    // The tie-break read is only for rows both rails wrote. Failing it must
    // not cost the user their profile (mobile cannot even buy without one):
    // fall back to the ids alone.
    const subscriptionSource = await subscriptionSourceOf(
      admin,
      userId,
      subscription,
    ).catch((e) => {
      logError(c, "subscription_source_failed", e);
      return railOf(subscription, null);
    });
    return c.json({
      profile: {
        id: profile.id,
        email: c.get("email"),
        displayName: profile.display_name,
        prefs: profile.prefs,
        createdAt: profile.created_at,
        ageConfirmed: !!profile.birth_date,
      },
      credits,
      subscription: subscription
        ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          pendingPlan: subscription.pending_plan ?? null,
          pendingAt: subscription.pending_at ?? null,
          entitled: isEntitled(subscription, Date.now()),
        }
        : null,
      subscriptionSource,
    });
  });

  app.patch("/profile", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.displayName !== "string" ||
      body.displayName.length > 80
    ) {
      return fail(
        c,
        400,
        "invalid_payload",
        "displayName required (max 80 chars)",
      );
    }
    const cleanName = body.displayName.replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim();
    const { error } = await admin
      .from("profiles")
      .update({ display_name: cleanName || null })
      .eq("id", c.get("userId"));
    if (error) {
      return fail(c, 400, "update_failed", "Profile could not be updated");
    }
    return c.json({ ok: true });
  });

  app.delete("/profile", async (c) => {
    const outcome = await deleteAccount(c, c.get("userId"));
    if ("error" in outcome) return outcome.error;
    return c.json(outcome.result, 202);
  });

  app.post("/profile/age", async (c) => {
    const body = await c.req.json().catch(() => null);
    const birthDate = parseBirthDate(body?.birthDate);
    if (!birthDate) {
      return fail(
        c,
        400,
        "invalid_payload",
        "A valid date of birth is required",
      );
    }

    if (ageFromBirthDate(birthDate) < 18) {
      const outcome = await deleteAccount(c, c.get("userId"));
      if ("error" in outcome) return outcome.error;
      return fail(c, 403, "underage", "You must be 18 or older to use Vansen");
    }

    const { error } = await admin
      .from("profiles")
      .update({
        birth_date: birthDate,
        age_confirmed_at: new Date().toISOString(),
      })
      .eq("id", c.get("userId"));
    if (error) {
      return fail(c, 400, "update_failed", "Could not save your date of birth");
    }
    return c.json({ ok: true });
  });

  app.put("/prefs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(c, 400, "invalid_payload", "Prefs object required");
    }
    const clean = sanitizePrefs(body as Record<string, unknown>);
    if (!clean) {
      return fail(c, 400, "invalid_payload", "Invalid preference values");
    }
    const { error } = await admin.from("profiles").update({ prefs: clean }).eq(
      "id",
      c.get("userId"),
    );
    if (error) {
      return fail(c, 400, "update_failed", "Preferences could not be saved");
    }
    return c.json({ ok: true });
  });

  app.post("/devices", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const platform = body?.platform;
    if (!token || token.length > 512) {
      return fail(c, 400, "invalid_token", "token required");
    }
    if (platform !== "ios" && platform !== "android") {
      return fail(
        c,
        400,
        "invalid_platform",
        "platform must be 'ios' or 'android'",
      );
    }
    const { error } = await admin.from("devices").upsert(
      {
        user_id: c.get("userId"),
        token,
        platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,token" },
    );
    if (error) {
      logError(c, "device_register_failed", new Error(error.message));
      return fail(c, 500, "internal", "Could not register device");
    }
    return c.json({ ok: true });
  });

  app.delete("/devices", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return fail(c, 400, "invalid_token", "token required");
    await admin.from("devices").delete().eq("user_id", c.get("userId")).eq(
      "token",
      token,
    );
    return c.json({ ok: true });
  });
}
