// The authorization server's routes (spec §R3). registerOauthPublicRoutes runs
// before auth: metadata (always served), register/authorize/token (503 while
// MCP_ENABLED is off) and revoke (always works). registerOauthSessionRoutes
// runs after it: the consent page's endpoints (gated) and the grant endpoints
// (never gated, so a user can always disconnect). Bodies live in oauth/*.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, App, Vars } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { handleAuthorize } from "../oauth/authorize.ts";
import { approveRequest, denyRequest, getRequest, listGrants, revokeGrant } from "../oauth/consent.ts";
import { buildAsMetadata } from "../oauth/metadata.ts";
import { AS_METADATA_PATH } from "../oauth/paths.ts";
import { handleRegister } from "../oauth/register.ts";
import { issuanceOff } from "../oauth/responses.ts";
import { handleRevoke, handleToken } from "../oauth/token.ts";

type Handler = (c: Context<Vars>, ctx: ApiContext) => Promise<Response>;

export function registerOauthPublicRoutes(app: App, ctx: ApiContext): void {
  const gated = (h: Handler) => async (c: Context<Vars>) => issuanceOff(c, ctx) ?? await h(c, ctx);

  // The local copy of the web origin's static file (spec R1); hosted clients
  // read https://vansen.vankode.com/.well-known/oauth-authorization-server.
  app.get(AS_METADATA_PATH, (c) => {
    const mcp = ctx.deps.env.mcp;
    if (!mcp) return fail(c, 503, "mcp_unconfigured", "The assistant connection is not configured.");
    return c.json(buildAsMetadata(mcp.issuer, mcp.apiUrl));
  });
  app.post("/oauth/register", gated(handleRegister));
  app.get("/oauth/authorize", gated(handleAuthorize));
  app.post("/oauth/token", gated(handleToken));
  // Revocation only ever takes access away, so it works even when switched off.
  app.post("/oauth/revoke", (c) => handleRevoke(c, ctx));
}

export function registerOauthSessionRoutes(app: App, ctx: ApiContext): void {
  const gated = (h: Handler) => async (c: Context<Vars>) => issuanceOff(c, ctx) ?? await h(c, ctx);
  const open = (h: Handler) => (c: Context<Vars>) => h(c, ctx);

  app.get("/oauth/requests/:id", gated(getRequest));
  app.post("/oauth/requests/:id/approve", gated(approveRequest));
  app.post("/oauth/requests/:id/deny", gated(denyRequest));
  app.get("/oauth/grants", open(listGrants));
  app.delete("/oauth/grants/:clientId", open(revokeGrant));
}
