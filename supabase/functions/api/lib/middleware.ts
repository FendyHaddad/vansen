// Global middleware, in two phases so the public routes sit between them.
// registerRequestMiddleware: CORS, the request id, the unhandled-error answer.
// registerAuthMiddleware: bearer auth, the 18+ age gate (memoised per app)
// and the shared per-user request budgets. Hono runs these in order.
import type { Context } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import type { ApiContext, App, Vars } from "./context.ts";
import { fail } from "./http.ts";

export function registerRequestMiddleware(app: App, ctx: ApiContext): void {
  const { allowedOrigin, logError } = ctx;

  app.use(
    "*",
    cors({
      origin: (origin) => allowedOrigin(origin) ?? undefined,
      allowHeaders: ["authorization", "content-type", "x-vansen-client"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    c.set("requestId", requestId);
    await next();
    // On every answer, not only the failures. The request people report is
    // often the one that succeeded slowly, or returned the wrong thing --
    // neither has an error body to carry the id in.
    c.header("x-request-id", requestId);
  });

  // Any exception nothing else caught: log it, answer with a request id the
  // user can quote back so the row is findable.
  app.onError((err, c) => {
    logError(c, "unhandled", err);
    return c.json(
      {
        error: {
          code: "internal",
          message: "Something went wrong",
          // Both names, on purpose: `errorId` is what every failure now calls
          // it, and `requestId` is what older clients already read. Dropping
          // it would silently blind an app we cannot force to update.
          errorId: c.get("requestId"),
          requestId: c.get("requestId"),
        },
      },
      500,
    );
  });
}

export function registerAuthMiddleware(app: App, ctx: ApiContext): void {
  const { admin, ageOkMemo } = ctx;

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (!token) return fail(c, 401, "unauthorized", "Missing token");
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      return fail(c, 401, "unauthorized", "Invalid token");
    }
    c.set("userId", data.user.id);
    c.set("email", data.user.email ?? "");
    await next();
  });

  /** Routes reachable before the gate: read your profile, pass the gate, or
   * delete the account. Everything else requires a confirmed 18+ DOB. */
  const AGE_EXEMPT = new Set([
    "GET /api/profile",
    "POST /api/profile/age",
    "DELETE /api/profile",
  ]);

  /** The age-gate refusal for this request, or null when it may continue. */
  async function ageGateRefusal(c: Context<Vars>): Promise<Response | null> {
    const key = `${c.req.method} ${new URL(c.req.url).pathname}`;
    if (AGE_EXEMPT.has(key)) return null;
    const userId = c.get("userId");
    if (ageOkMemo.has(userId)) return null;
    const { data } = await admin
      .from("profiles")
      .select("birth_date")
      .eq("id", userId)
      .single();
    if (!data?.birth_date) {
      return fail(
        c,
        403,
        "age_unconfirmed",
        "Confirm your date of birth to continue",
      );
    }
    if (ageOkMemo.size > 10_000) ageOkMemo.clear();
    ageOkMemo.add(userId);
    return null;
  }

  app.use("*", async (c, next) => {
    const refused = await ageGateRefusal(c);
    if (refused) return refused;
    await next();
  });

  /** Which shared budget this request draws on, if any. */
  function requestBucket(c: Context<Vars>): "generation" | "upload" | null {
    const path = new URL(c.req.url).pathname;
    return c.req.method !== "POST" ? null
      : path === "/api/generations" || /^\/api\/generations\/[^/]+\/retry$/.test(path)
      ? "generation"
      : path === "/api/uploads" || path === "/api/edits/save" ? "upload" : null;
  }

  /** Take one slot from the bucket: a refusal Response, or null to continue. */
  async function requestSlotRefusal(
    c: Context<Vars>,
    bucket: "generation" | "upload",
  ): Promise<Response | null> {
    const { data, error } = await admin.rpc("fn_take_request_slot", {
      p_user: c.get("userId"), p_bucket: bucket,
    });
    if (error || !data) {
      return fail(c, 503, "request_limit_unavailable", "Requests are temporarily unavailable. Please try again shortly.");
    }
    if (!data.allowed) {
      const res = fail(c, 429, "rate_limited", "Too many requests. Please wait a moment and try again.");
      res.headers.set("retry-after", String(data.retryAfterSeconds));
      return res;
    }
    return null;
  }

  // Shared database budgets survive cold starts and concurrent API instances.
  // Run before parsing uploads, moderation, or reserving provider spend.
  app.use("*", async (c, next) => {
    const bucket = requestBucket(c);
    const refused = bucket ? await requestSlotRefusal(c, bucket) : null;
    if (refused) return refused;
    await next();
  });
}
