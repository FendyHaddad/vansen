// GET /oauth/authorize. The client, the exact redirect_uri and the parameters
// are checked first; failing any gets a plain 400 page. An unregistered address
// must never receive the user, and with dynamic registration a registered one
// may be the attacker's, so a bad parameter is not an instant redirect either
// (RFC 9700 §4.11.2). Success stores a 10-minute request and opens consent on
// the issuer's origin.
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

/** The issuer when it is an origin root (hosted: always https://vansen.vankode.com). */
function issuerOrigin(issuer: string): string | null {
  try {
    const url = new URL(issuer);
    return url.pathname === "/" && !url.search ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The web origin that hosts the consent page: the issuer, which is where the
 * user's session lives. Only a local run whose issuer is `<api>/oauth` falls
 * back to the first APP_ORIGIN. Nothing configured is null (a 503), never a
 * localhost guess that any local process could answer.
 */
export function consentOrigin(issuer: string, appOrigins: string[]): string | null {
  return issuerOrigin(issuer) ?? appOrigins[0] ?? null;
}

export async function handleAuthorize(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const q = c.req.query();
  const mcp = ctx.deps.env.mcp!;
  const origin = consentOrigin(mcp.issuer, ctx.APP_ORIGINS);
  if (!origin) return c.text("Sign-in is not configured on this server.\n", 503);
  const client = await ctx.oauth.clientById(q.client_id ?? "");
  if (client === UNAVAILABLE) return c.text("Sign-in is unavailable right now. Try again shortly.\n", 503);
  if (!client) {
    return refusalPage(c, "this app is not registered with Vansen. Remove and re-add the connector in your assistant.");
  }
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return refusalPage(c, "the redirect address does not match what this app registered.");
  }
  const problem = paramProblem(q, mcp.resourceUrl);
  if (problem) return refusalPage(c, `${problem[1]} (${problem[0]})`);

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
  if (!stored) {
    return c.redirect(withParams(q.redirect_uri, {
      error: "temporarily_unavailable",
      error_description: "Vansen could not start the sign-in. Try again.",
      state: q.state,
      iss: mcp.issuer,
    }), 302);
  }
  return c.redirect(`${origin}/oauth/consent?authorization_id=${id}`, 302);
}
