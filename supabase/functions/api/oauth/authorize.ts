// GET /oauth/authorize. The client and the exact redirect_uri are checked first:
// failing either gets a plain 400 page, because redirecting would hand an error
// (and the user) to an address nobody registered. Every later problem goes back
// to the redirect_uri. Success stores a 10-minute request and opens consent.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "../lib/context.ts";
import { OAUTH_SCOPE } from "./metadata.ts";
import { withParams } from "./redirects.ts";
import { refusalPage } from "./responses.ts";
import { UNAVAILABLE } from "./store.ts";

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE = 1024;
const REQUEST_TTL_MS = 10 * 60_000;

/** The first problem with the request's parameters, as [error, description]. */
function paramProblem(q: Record<string, string>, resourceUrl: string): [string, string] | null {
  if (q.response_type !== "code") return ["unsupported_response_type", "Only response_type=code is supported."];
  if (q.code_challenge_method !== "S256") return ["invalid_request", "PKCE with code_challenge_method=S256 is required."];
  if (!CHALLENGE.test(q.code_challenge ?? "")) return ["invalid_request", "code_challenge must be a base64url SHA-256."];
  if ((q.state ?? "").length > MAX_STATE) return ["invalid_request", "state is too long."];
  if (q.resource && q.resource !== resourceUrl) return ["invalid_target", "resource must be the Vansen MCP URL."];
  return null;
}

/** Where the browser goes to approve: the web app's consent page. */
function consentUrl(ctx: ApiContext, authorizationId: string): string {
  const origin = ctx.APP_ORIGINS[0] ?? "http://localhost:4200";
  return `${origin}/oauth/consent?authorization_id=${authorizationId}`;
}

export async function handleAuthorize(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const q = c.req.query();
  const client = await ctx.oauth.clientById(q.client_id ?? "");
  if (client === UNAVAILABLE) return c.text("Sign-in is unavailable right now. Try again shortly.\n", 503);
  if (!client) return refusalPage(c, "this app is not registered with Vansen.");
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return refusalPage(c, "the redirect address does not match what this app registered.");
  }
  const back = (error: string, description: string) =>
    c.redirect(withParams(q.redirect_uri, { error, error_description: description, state: q.state }), 302);
  const problem = paramProblem(q, ctx.deps.env.mcp!.resourceUrl);
  if (problem) return back(...problem);

  const id = crypto.randomUUID();
  const stored = await ctx.oauth.createRequest({
    id,
    client_id: client.id,
    redirect_uri: q.redirect_uri,
    state: q.state ?? null,
    code_challenge: q.code_challenge,
    scope: OAUTH_SCOPE,
    resource: q.resource || null,
    expires_at: new Date(ctx.deps.now().getTime() + REQUEST_TTL_MS).toISOString(),
  });
  if (!stored) return back("temporarily_unavailable", "Vansen could not start the sign-in. Try again.");
  return c.redirect(consentUrl(ctx, id), 302);
}
