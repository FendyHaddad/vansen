// POST /oauth/token (authorization_code with PKCE S256, refresh_token with
// rotation) and POST /oauth/revoke (RFC 7009, always 200). The checks that must
// be atomic (single use, reuse revocation, binding) run inside the RPCs; this
// file validates shapes, hashes secrets and shapes the RFC 6749 answers.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "../lib/context.ts";
import { OAUTH_SCOPE } from "./metadata.ts";
import { formOf, NO_STORE, oauthError } from "./responses.ts";
import {
  ACCESS_PREFIX,
  ACCESS_TTL_SECONDS,
  CODE_PREFIX,
  isCodeVerifier,
  randomSecret,
  REFRESH_PREFIX,
  s256,
  sha256Hex,
} from "./secrets.ts";
import { type GrantOutcome, UNAVAILABLE } from "./store.ts";

type Form = Record<string, string>;

interface NewPair {
  access: string;
  refresh: string;
  accessHash: string;
  refreshHash: string;
}

async function newPair(): Promise<NewPair> {
  const access = randomSecret(ACCESS_PREFIX);
  const refresh = randomSecret(REFRESH_PREFIX);
  return { access, refresh, accessHash: await sha256Hex(access), refreshHash: await sha256Hex(refresh) };
}

/** Strict rotation revokes the grant on reuse. The log makes each revocation
 * visible, so a client that trips it (parallel refresh, a retried lost
 * response) shows up before anyone considers a grace window. */
function logReuse(kind: "code" | "refresh", outcome: GrantOutcome): void {
  if (outcome === UNAVAILABLE || !("error" in outcome) || !outcome.reuse) return;
  console.log(JSON.stringify({ event: "oauth_reuse", kind, grantId: outcome.grantId, clientId: outcome.clientId }));
}

/** The RFC 6749 answer for an RPC outcome: the new pair, or the error. */
function answer(c: Context<Vars>, outcome: GrantOutcome, pair: NewPair): Response {
  if (outcome === UNAVAILABLE) {
    return oauthError(c, 503, "temporarily_unavailable", "Vansen could not issue tokens right now.");
  }
  if ("error" in outcome && outcome.error === "invalid_client") {
    return oauthError(c, 401, "invalid_client", "Unknown client_id.");
  }
  if ("error" in outcome) {
    return oauthError(c, 400, "invalid_grant", "The code or refresh token is invalid, expired, revoked or already used.");
  }
  return c.json({
    access_token: pair.access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: pair.refresh,
    scope: OAUTH_SCOPE,
  }, 200, NO_STORE);
}

async function authorizationCode(c: Context<Vars>, ctx: ApiContext, f: Form): Promise<Response> {
  if (!f.code || !f.redirect_uri || !f.client_id || !f.code_verifier) {
    return oauthError(c, 400, "invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
  }
  if (!isCodeVerifier(f.code_verifier)) {
    return oauthError(c, 400, "invalid_request", "code_verifier must be 43-128 unreserved characters.");
  }
  if (f.resource && f.resource !== ctx.deps.env.mcp!.resourceUrl) {
    return oauthError(c, 400, "invalid_target", "resource must be the Vansen MCP URL.");
  }
  const pair = await newPair();
  const outcome = await ctx.oauth.redeemCode({
    codeHash: await sha256Hex(f.code),
    clientId: f.client_id,
    redirectUri: f.redirect_uri,
    challenge: await s256(f.code_verifier),
    accessHash: pair.accessHash,
    refreshHash: pair.refreshHash,
  });
  logReuse("code", outcome);
  return answer(c, outcome, pair);
}

async function refreshToken(c: Context<Vars>, ctx: ApiContext, f: Form): Promise<Response> {
  if (!f.refresh_token || !f.client_id) {
    return oauthError(c, 400, "invalid_request", "refresh_token and client_id are required.");
  }
  if (f.resource && f.resource !== ctx.deps.env.mcp!.resourceUrl) {
    return oauthError(c, 400, "invalid_target", "resource must be the Vansen MCP URL.");
  }
  const pair = await newPair();
  const outcome = await ctx.oauth.rotateRefresh({
    refreshHash: await sha256Hex(f.refresh_token),
    clientId: f.client_id,
    accessHash: pair.accessHash,
    newRefreshHash: pair.refreshHash,
  });
  logReuse("refresh", outcome);
  return answer(c, outcome, pair);
}

export async function handleToken(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const form = await formOf(c);
  if (!form.grant_type) return oauthError(c, 400, "invalid_request", "grant_type is required.");
  if (form.grant_type === "authorization_code") return await authorizationCode(c, ctx, form);
  if (form.grant_type === "refresh_token") return await refreshToken(c, ctx, form);
  return oauthError(c, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** RFC 7009: 200 whatever the token was, so revocation reveals nothing. */
export async function handleRevoke(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const form = await formOf(c);
  const token = form.token ?? "";
  const ours = [ACCESS_PREFIX, REFRESH_PREFIX, CODE_PREFIX].some((p) => token.startsWith(p));
  if (ours) await ctx.oauth.revokeToken(await sha256Hex(token), form.client_id || null);
  return c.body(null, 200, NO_STORE);
}
