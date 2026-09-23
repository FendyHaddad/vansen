// The assistant connection: POST /mcp (MCP Streamable HTTP, stateless, JSON
// responses) and its public PRM at /mcp/.well-known/oauth-protected-resource.
// registerMcpPublicRoutes runs before auth (PRM, kill switch, 405s);
// registerMcpRoutes after it. Token auth lives in lib/bearer-auth.ts.
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { mcpChallenge } from "../lib/mcp-challenge.ts";
import { PRM_SUFFIX, protectedResourceMetadata } from "../mcp/metadata.ts";
import { buildMcpServer } from "../mcp/server.ts";

export function registerMcpPublicRoutes(app: App, ctx: ApiContext): void {
  const { deps } = ctx;

  // Served even when MCP_ENABLED is off: discovery is harmless, and a client
  // mid-setup gets the real reason (503 mcp_disabled) from /mcp itself.
  app.get(`/mcp${PRM_SUFFIX}`, (c) => {
    const mcp = deps.env.mcp;
    if (!mcp) return fail(c, 503, "mcp_unconfigured", "The assistant connection is not configured.");
    return c.json(protectedResourceMetadata(mcp));
  });

  app.use("/mcp", async (c, next) => {
    if (!deps.env.releaseFlags.mcpEnabled) {
      return fail(c, 503, "mcp_disabled", "The assistant connection is switched off.");
    }
    // Stateless: a GET would hold an SSE stream (and an Edge worker) open
    // with nothing to send, and there is no session to DELETE.
    if (c.req.method !== "POST") {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        405,
        { allow: "POST" },
      );
    }
    await next();
  });
}

export function registerMcpRoutes(app: App, ctx: ApiContext): void {
  app.post("/mcp", async (c) => {
    // Auth already refused anything but a live vsn_at_ token; this guard
    // keeps a future routing slip from running the tools as nobody's grant.
    const clientId = c.get("oauthClientId");
    const grantId = c.get("grantId");
    if (!clientId || !grantId) {
      return mcpChallenge(c, ctx.deps.env.mcp, "Connect through your assistant's sign-in, not an app session.");
    }
    // Server-set: every generation and app_errors row from here is 'mcp',
    // whatever x-vansen-client says.
    c.set("client", "mcp");
    const server = buildMcpServer({
      c,
      ctx,
      userId: c.get("userId"),
      clientId,
      grantId,
      sleep: ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
}
