// The session endpoints behind the web app: the consent page's request details,
// Allow and Deny, and the Connected tab's grant list and Disconnect. They run
// after the normal auth middleware, so the caller is a signed-in app session.
// A code is issued only here, and only its hash is stored. alreadyGranted is
// true only for a redirect URI the user already approved on this grant (C1).
// Every authorization response carries iss (RFC 9207) against mix-up attacks.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { redirectHost, withParams } from "./redirects.ts";
import { CODE_PREFIX, randomSecret, sha256Hex } from "./secrets.ts";
import { UNAVAILABLE } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (c: Context<Vars>) =>
  fail(c, 404, "authorization_not_found", "This sign-in request has expired. Start again from your assistant.");
const unavailable = (c: Context<Vars>) =>
  fail(c, 503, "oauth_unavailable", "Connected assistants are unavailable right now. Please try again shortly.");

export async function getRequest(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return notFound(c);
  const request = await ctx.oauth.liveRequest(id, ctx.deps.now());
  if (request === UNAVAILABLE) return unavailable(c);
  if (!request) return notFound(c);
  const [client, granted] = await Promise.all([
    ctx.oauth.clientById(request.client_id),
    ctx.oauth.isApproved(c.get("userId"), request.client_id, request.redirect_uri),
  ]);
  if (client === UNAVAILABLE || granted === UNAVAILABLE) return unavailable(c);
  if (!client) return notFound(c);
  return c.json({
    clientName: client.client_name,
    redirectUri: request.redirect_uri,
    redirectHost: redirectHost(request.redirect_uri),
    scope: request.scope,
    alreadyGranted: granted,
  });
}

export async function approveRequest(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return notFound(c);
  const code = randomSecret(CODE_PREFIX);
  const approved = await ctx.oauth.approve(id, c.get("userId"), await sha256Hex(code));
  if (approved === UNAVAILABLE) return unavailable(c);
  if (!approved) return notFound(c);
  const iss = ctx.deps.env.mcp!.issuer;
  return c.json({ redirectUrl: withParams(approved.redirectUri, { code, state: approved.state, iss }) });
}

export async function denyRequest(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) return notFound(c);
  const denied = await ctx.oauth.deny(id, ctx.deps.now());
  if (denied === UNAVAILABLE) return unavailable(c);
  if (!denied) return notFound(c);
  const iss = ctx.deps.env.mcp!.issuer;
  return c.json({ redirectUrl: withParams(denied.redirect_uri, { error: "access_denied", state: denied.state, iss }) });
}

/** Every host the user approved for a grant, so none can hide behind another. */
function approvedHosts(uris: string[] | null): string {
  return [...new Set((uris ?? []).map(redirectHost).filter(Boolean))].join(", ");
}

export async function listGrants(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const grants = await ctx.oauth.activeGrants(c.get("userId"));
  if (grants === UNAVAILABLE) return unavailable(c);
  const clients = await ctx.oauth.clientsByIds([...new Set(grants.map((g) => g.client_id))]);
  if (clients === UNAVAILABLE) return unavailable(c);
  const byId = new Map(clients.map((cl) => [cl.id, cl]));
  return c.json({
    grants: grants.map((g) => {
      const client = byId.get(g.client_id);
      return {
        clientId: g.client_id,
        clientName: client?.client_name ?? "Unknown app",
        redirectHost: approvedHosts(g.approved_redirect_uris),
        createdAt: g.created_at,
        lastUsedAt: g.last_used_at,
      };
    }),
  });
}

export async function revokeGrant(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const revoked = await ctx.oauth.revokeUserGrant(c.get("userId"), c.req.param("clientId") ?? "");
  if (revoked === UNAVAILABLE) return unavailable(c);
  if (!revoked) return fail(c, 404, "grant_not_found", "That assistant is not connected.");
  return c.body(null, 204);
}
