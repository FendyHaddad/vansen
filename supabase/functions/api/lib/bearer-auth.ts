// Who is calling. Containment is structural: /mcp accepts only our opaque
// vsn_at_ tokens (resolved through fn_oauth_resolve_token), and every other
// route only GoTrue sessions (getUser); a vsn_ token is refused before it.
// Each function returns a refusal Response, or null after setting the caller.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "./context.ts";
import { fail } from "./http.ts";
import { mcpChallenge } from "./mcp-challenge.ts";
import { ACCESS_PREFIX, sha256Hex } from "../oauth/secrets.ts";
import { UNAVAILABLE } from "../oauth/store.ts";

/** Every secret our authorization server issues starts with this. */
const OUR_TOKEN_PREFIX = "vsn_";

export function bearerOf(c: Context<Vars>): string {
  return c.req.header("authorization")?.replace(/^Bearer /i, "") ?? "";
}

/** The app's own routes: a Supabase session. */
export async function authenticateSession(c: Context<Vars>, ctx: ApiContext): Promise<Response | null> {
  const token = bearerOf(c);
  if (!token) return fail(c, 401, "unauthorized", "Missing token");
  // Our own tokens are refused here, so none ever reaches GoTrue or its logs.
  if (token.startsWith(OUR_TOKEN_PREFIX)) return fail(c, 401, "unauthorized", "Invalid token");
  const { data, error } = await ctx.admin.auth.getUser(token);
  if (error || !data.user) return fail(c, 401, "unauthorized", "Invalid token");
  c.set("userId", data.user.id);
  c.set("email", data.user.email ?? "");
  return null;
}

/** /mcp: an assistant's access token, issued by our authorization server. */
export async function authenticateMcp(c: Context<Vars>, ctx: ApiContext): Promise<Response | null> {
  const mcp = ctx.deps.env.mcp;
  const token = bearerOf(c);
  if (!token) return mcpChallenge(c, mcp, "Missing token");
  if (!token.startsWith(ACCESS_PREFIX)) {
    return mcpChallenge(c, mcp, "Connect through your assistant's sign-in, not an app session.");
  }
  const grant = await ctx.oauth.resolveAccess(await sha256Hex(token));
  if (grant === UNAVAILABLE) {
    return fail(c, 503, "auth_unavailable", "Sign-in is temporarily unavailable. Please try again shortly.");
  }
  if (!grant) return mcpChallenge(c, mcp, "Invalid token", true);
  c.set("userId", grant.userId);
  c.set("email", "");
  c.set("oauthClientId", grant.clientId);
  c.set("grantId", grant.grantId);
  return null;
}
