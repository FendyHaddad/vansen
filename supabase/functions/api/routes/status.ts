// GET /models (the kill-switch states) and POST /errors (client error
// reports: 20 an hour per user, message + stack only, never bodies).
import type { ApiContext, App } from "../lib/context.ts";
import { clientOf, fail, sanitizeLabel } from "../lib/http.ts";

export function registerStatusRoutes(app: App, ctx: ApiContext): void {
  const { admin } = ctx;

  app.get("/models", async (c) => {
    const { data } = await admin.from("models").select("id,enabled");
    return c.json({ models: data ?? [] });
  });

  // Client-side error reports (web ErrorHandler, mobile crash hooks). Same
  // privacy rule as logError: message + stack only, never bodies or headers.
  app.post("/errors", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const message = typeof body?.message === "string"
      ? body.message.trim().slice(0, 1000)
      : "";
    if (!message) return fail(c, 400, "invalid_payload", "message required");

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin
      .from("app_errors")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source", "client")
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= 20) {
      return fail(c, 429, "rate_limited", "Too many error reports");
    }

    const { error } = await admin.from("app_errors").insert({
      source: "client",
      client: clientOf(c),
      route: sanitizeLabel(body.route),
      code: sanitizeLabel(body.code),
      message,
      stack: typeof body.stack === "string" && body.stack
        ? body.stack.slice(0, 4000)
        : null,
      app_version: sanitizeLabel(body.appVersion),
      user_id: userId,
      request_id: c.get("requestId") ?? null,
    });
    if (error) {
      return fail(c, 500, "report_failed", "Could not record the report");
    }
    return c.body(null, 204);
  });
}
