// Global middleware, in two phases so the public routes sit between them.
// registerRequestMiddleware: CORS, the request id, the unhandled-error answer.
// registerAuthMiddleware: bearer auth, OAuth token containment (assistant
// tokens only on /mcp, app sessions never there), the 18+ age gate (memoised
// per app) and the shared per-user request budgets. Hono runs these in order.
// Every path check reads c.req.path, the decoded path Hono routes on, so a
// percent-encoded path cannot reach a route while dodging its checks.
import type { Context } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import type { ApiContext, App, Vars } from "./context.ts";
import type { McpEnv } from "./deps.ts";
import { fail } from "./http.ts";
import { oauthClientIdOf } from "./token-claims.ts";
import { MCP_PATH, wwwAuthenticate } from "../mcp/metadata.ts";
import { type RequestBucket, takeRequestSlot } from "../services/request-slots.ts";

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

/** A 401 an MCP client can act on: the header names our PRM. */
export function mcpChallenge(
  c: Context<Vars>,
  mcp: McpEnv | undefined,
  message: string,
  invalid = false,
): Response {
  const res = fail(c, 401, "unauthorized", message);
  res.headers.set("www-authenticate", wwwAuthenticate(mcp, invalid));
  return res;
}

export function registerAuthMiddleware(app: App, ctx: ApiContext): void {
  const { admin, ageConfirmed, deps } = ctx;

  const isMcp = (c: Context<Vars>) => c.req.path === MCP_PATH;
  const challenge = (c: Context<Vars>, message: string, invalid = false) =>
    mcpChallenge(c, deps.env.mcp, message, invalid);

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (!token && isMcp(c)) return challenge(c, "Missing token");
    if (!token) return fail(c, 401, "unauthorized", "Missing token");
    const { data, error } = await admin.auth.getUser(token);
    if ((error || !data.user) && isMcp(c)) return challenge(c, "Invalid token", true);
    if (error || !data.user) {
      return fail(c, 401, "unauthorized", "Invalid token");
    }
    // Containment (spec §3). An assistant's OAuth token is a full Supabase JWT
    // for the user; `client_id` is the only thing that tells it apart, and
    // Supabase stamps no audience we could bind to instead. So: OAuth tokens
    // only on /mcp, and the app's own session never on /mcp.
    const oauthClientId = oauthClientIdOf(token);
    if (oauthClientId && !isMcp(c)) {
      return fail(c, 403, "token_not_allowed", "This token only works for the assistant connection.");
    }
    if (!oauthClientId && isMcp(c)) {
      return challenge(c, "Connect through your assistant's sign-in, not an app session.");
    }
    c.set("userId", data.user.id);
    c.set("email", data.user.email ?? "");
    if (oauthClientId) c.set("oauthClientId", oauthClientId);
    await next();
  });

  /** Routes reachable before the gate: read your profile, pass the gate, or
   * delete the account. Everything else requires a confirmed 18+ DOB.
   * /mcp is gated per tool instead, so an assistant gets a readable tool
   * error ("confirm your date of birth") rather than a broken connection. */
  const AGE_EXEMPT = new Set([
    "GET /api/profile",
    "POST /api/profile/age",
    "DELETE /api/profile",
    `POST ${MCP_PATH}`,
  ]);

  /** The age-gate refusal for this request, or null when it may continue. */
  async function ageGateRefusal(c: Context<Vars>): Promise<Response | null> {
    const key = `${c.req.method} ${c.req.path}`;
    if (AGE_EXEMPT.has(key)) return null;
    if (await ageConfirmed(c.get("userId"))) return null;
    return fail(
      c,
      403,
      "age_unconfirmed",
      "Confirm your date of birth to continue",
    );
  }

  app.use("*", async (c, next) => {
    const refused = await ageGateRefusal(c);
    if (refused) return refused;
    await next();
  });

  /** Which shared budget this request draws on, if any. The `mcp` bucket is
   * taken per generate-type tool call inside /mcp, not per HTTP request. */
  function requestBucket(c: Context<Vars>): RequestBucket | null {
    const path = c.req.path;
    return c.req.method !== "POST" ? null
      : path === "/api/generations" || /^\/api\/generations\/[^/]+\/retry$/.test(path)
      ? "generation"
      : path === "/api/uploads" || path === "/api/edits/save" ? "upload" : null;
  }

  /** Take one slot from the bucket: a refusal Response, or null to continue. */
  async function requestSlotRefusal(
    c: Context<Vars>,
    bucket: RequestBucket,
  ): Promise<Response | null> {
    const slot = await takeRequestSlot(admin, c.get("userId"), bucket);
    if ("unavailable" in slot) {
      return fail(c, 503, "request_limit_unavailable", "Requests are temporarily unavailable. Please try again shortly.");
    }
    if (!slot.allowed) {
      const res = fail(c, 429, "rate_limited", "Too many requests. Please wait a moment and try again.");
      res.headers.set("retry-after", String(slot.retryAfterSeconds));
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
