// Structural containment (spec R3): /mcp accepts only our opaque vsn_at_
// tokens, every other route only GoTrue sessions, so neither token works where
// the other belongs. Plus the /mcp front door: PRM, kill switch, 405s, the age
// exemption, the server-set client tag and percent-encoded paths.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { Hono } from "jsr:@hono/hono";
import { createApp } from "./app.ts";
import { createContext, type Vars } from "./lib/context.ts";
import { registerMcpRoutes } from "./routes/mcp.ts";
import { TEST_USER } from "./testing/fakes.ts";
import {
  MCP_HEADERS,
  MCP_RESOURCE,
  mcpApp,
  mcpDeps,
  OAUTH_TOKEN,
  rpc,
  SESSION_JWT,
} from "./testing/mcp.ts";
import { connect } from "./testing/oauth-flow.ts";

const PRM_URL = `${MCP_RESOURCE}/.well-known/oauth-protected-resource`;
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

function rawPost(app: Hono<Vars>, path: string, token: string, body: unknown = TOOLS_LIST) {
  return app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

Deno.test("a vsn_at_ token is accepted on /mcp", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assertEquals(answer.status, 200);
  assertEquals(answer.body.result.serverInfo.name, "vansen");
  assertEquals(answer.headers.get("mcp-session-id"), null, "stateless: no session id");
});

Deno.test("a vsn_at_ token is refused on /profile and the other app routes (GoTrue does not know it)", async () => {
  const { app } = mcpApp();
  for (const [method, path] of [
    ["GET", "/api/profile"],
    ["DELETE", "/api/profile"],
    ["POST", "/api/generations"],
    ["GET", "/api/billing/overview"],
    ["POST", "/api/billing/subscribe"],
    ["GET", "/api/%70rofile"],
  ]) {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${OAUTH_TOKEN}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assertEquals(res.status, 401, `${method} ${path}`);
    assertEquals((await res.json()).error.code, "unauthorized");
  }
});

Deno.test("no vsn_ token is ever forwarded to GoTrue (nor lands in its request logs)", async () => {
  const { app, db } = mcpApp();
  const seen: string[] = [];
  const getUser = db.auth.getUser;
  db.auth.getUser = (token: string) => {
    seen.push(token);
    return getUser(token);
  };
  for (const token of [OAUTH_TOKEN, `vsn_rt_${"B".repeat(43)}`, `vsn_ac_${"C".repeat(43)}`]) {
    const res = await app.request("/api/profile", { headers: { authorization: `Bearer ${token}` } });
    assertEquals(res.status, 401, token.slice(0, 7));
    await res.body?.cancel();
  }
  assertEquals(seen, [], "refused before getUser");
});

Deno.test("the app's session JWT still works on /profile, and is refused on /mcp", async () => {
  const { app } = mcpApp();
  assertEquals((await app.request("/api/profile", { headers: { authorization: `Bearer ${SESSION_JWT}` } })).status, 200);
  const answer = await rpc(app, "tools/list", {}, { token: SESSION_JWT });
  assertEquals(answer.status, 401);
  const header = answer.headers.get("www-authenticate") ?? "";
  assertStringIncludes(header, `resource_metadata="${PRM_URL}"`);
  assert(!header.includes("invalid_token"), "a JWT is not one of our tokens: no refresh hint");
});

Deno.test("issued tokens are opaque, not JWTs, so GoTrue's /auth/v1 cannot accept them", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  for (const token of [conn.accessToken, conn.refreshToken, conn.code]) {
    assert(!token.includes("."), "no JWT segments");
    assertEquals(token.length, 7 + 43);
  }
});

Deno.test("a bare /mcp call gets 401 with WWW-Authenticate naming the PRM", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "tools/list", {}, { token: null });
  assertEquals(answer.status, 401);
  assertStringIncludes(answer.headers.get("www-authenticate") ?? "", `resource_metadata="${PRM_URL}"`);
});

Deno.test("an unknown, expired or revoked vsn_at_ token gets 401 invalid_token", async () => {
  const { app, db } = mcpApp();
  const check = async (label: string) => {
    const answer = await rpc(app, "tools/list");
    assertEquals(answer.status, 401, label);
    assertStringIncludes(answer.headers.get("www-authenticate") ?? "", 'error="invalid_token"');
  };
  const unknown = await rpc(app, "tools/list", {}, { token: `vsn_at_${"B".repeat(43)}` });
  assertEquals(unknown.status, 401);
  assertStringIncludes(unknown.headers.get("www-authenticate") ?? "", 'error="invalid_token"');
  db.tables.oauth_tokens[0].expires_at = db.now().toISOString();
  await check("expired");
  db.tables.oauth_tokens[0].expires_at = "2099-01-01T00:00:00Z";
  db.tables.oauth_grants[0].revoked_at = db.now().toISOString();
  await check("grant revoked");
});

Deno.test("a database failure resolving the token is a 503, not a 401", async () => {
  const { app, db } = mcpApp();
  db.failNext("rpc.fn_oauth_resolve_token", "boom");
  const answer = await rpc(app, "tools/list");
  assertEquals(answer.status, 503);
});

Deno.test("resolving the token records last use on the grant", async () => {
  const { app, db } = mcpApp();
  await rpc(app, "tools/list");
  assertEquals(db.tables.oauth_grants[0].last_used_at, db.now().toISOString());
});

Deno.test("the PRM is public and names our issuer and the vansen scope", async () => {
  const { app } = mcpApp();
  const res = await app.request("/api/mcp/.well-known/oauth-protected-resource");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    resource: MCP_RESOURCE,
    authorization_servers: ["https://vansen.vankode.com"],
    scopes_supported: ["vansen"],
    bearer_methods_supported: ["header"],
    resource_name: "Vansen",
  });
});

Deno.test("MCP_ENABLED off: /mcp answers 503 mcp_disabled, the PRM is still served", async () => {
  const deps = mcpDeps();
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const app = createApp(deps);
  const answer = await rpc(app, "tools/list");
  assertEquals(answer.status, 503);
  assertEquals(answer.body.error.code, "mcp_disabled");
  assertEquals((await app.request("/api/mcp/.well-known/oauth-protected-resource")).status, 200);
});

Deno.test("GET and DELETE on /mcp are 405: a stateless GET would hold an Edge worker", async () => {
  const { app } = mcpApp();
  for (const method of ["GET", "DELETE"]) {
    const res = await app.request("/api/mcp", {
      method,
      headers: { ...MCP_HEADERS, authorization: `Bearer ${OAUTH_TOKEN}` },
    });
    assertEquals(res.status, 405, method);
    assertEquals(res.headers.get("allow"), "POST");
    await res.body?.cancel();
  }
});

Deno.test("an assistant user who has not confirmed their age still reaches /mcp (tools refuse)", async () => {
  const { app, db } = mcpApp();
  db.tables.profiles = [{ id: TEST_USER, birth_date: null, strikes: 0, prefs: {} }];
  assertEquals((await rpc(app, "tools/list")).status, 200);
  assertEquals((await rawPost(app, "/api/%6Dcp", OAUTH_TOKEN)).status, 200, "also on the encoded path");
});

Deno.test("a session token on a percent-encoded /api/%6Dcp is still refused with the challenge", async () => {
  const { app } = mcpApp();
  const res = await rawPost(app, "/api/%6Dcp", SESSION_JWT);
  assertEquals(res.status, 401);
  assertStringIncludes(res.headers.get("www-authenticate") ?? "", `resource_metadata="${PRM_URL}"`);
});

Deno.test("no app route accepts 'mcp' from the x-vansen-client header", async () => {
  const { app, db } = mcpApp();
  db.tables.subscriptions = [{ user_id: TEST_USER, plan: "pro", status: "active", current_period_end: "2099-01-01T00:00:00Z" }];
  db.tables.models = [{ id: "flux", enabled: true, min_plan: "studio" }];
  await app.request("/api/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${SESSION_JWT}`, "content-type": "application/json", "x-vansen-client": "mcp" },
    body: JSON.stringify({ op: "generate", familyId: "flux", prompt: "a fox", settings: { aspectRatio: "1:1" } }),
  });
  const reserve = db.rpcCalls.find((c) => c.name === "fn_reserve_generation");
  assert(reserve, "submitted");
  assertEquals((reserve.args.p_items as Record<string, unknown>[])[0].client, "");
});

Deno.test("the /mcp handler itself refuses a request with no grant", async () => {
  // Defence in depth: mount the handler without the auth middleware.
  const ctx = createContext(mcpDeps());
  const bare = new Hono<Vars>().basePath("/api");
  bare.use("*", async (c, next) => {
    c.set("userId", TEST_USER);
    await next();
  });
  registerMcpRoutes(bare, ctx);
  const res = await rawPost(bare, "/api/mcp", SESSION_JWT);
  assertEquals(res.status, 401);
  assertStringIncludes(res.headers.get("www-authenticate") ?? "", `resource_metadata="${PRM_URL}"`);
});
