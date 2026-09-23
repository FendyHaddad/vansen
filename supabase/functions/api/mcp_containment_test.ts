// Token containment and the /mcp front door (spec §3, §5, §8): OAuth tokens
// only on /mcp, session tokens never on /mcp, the PRM, the kill switch, 405s.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import {
  MCP_HEADERS,
  MCP_RESOURCE,
  mcpApp,
  mcpDeps,
  OAUTH_TOKEN,
  rpc,
  SESSION_JWT,
} from "./testing/mcp.ts";

const PRM_URL = `${MCP_RESOURCE}/.well-known/oauth-protected-resource`;

Deno.test("an OAuth token is refused on /profile with 403 token_not_allowed", async () => {
  const { app } = mcpApp();
  const res = await app.request("/api/profile", {
    headers: { authorization: `Bearer ${OAUTH_TOKEN}` },
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "token_not_allowed");
});

Deno.test("an OAuth token is refused on every /billing route", async () => {
  const { app } = mcpApp();
  for (const [method, path] of [
    ["POST", "/api/billing/subscribe"],
    ["POST", "/api/billing/pack"],
    ["GET", "/api/billing/overview"],
    ["POST", "/api/billing/portal"],
    ["POST", "/api/billing/cancel"],
  ]) {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${OAUTH_TOKEN}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).error.code, "token_not_allowed");
  }
});

Deno.test("an OAuth token cannot delete the account or reach generations directly", async () => {
  const { app } = mcpApp();
  for (const [method, path] of [["DELETE", "/api/profile"], ["POST", "/api/generations"]]) {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${OAUTH_TOKEN}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assertEquals(res.status, 403, `${method} ${path}`);
  }
});

Deno.test("the app's session token still works on /profile", async () => {
  const { app } = mcpApp();
  const res = await app.request("/api/profile", {
    headers: { authorization: `Bearer ${SESSION_JWT}` },
  });
  assertEquals(res.status, 200);
});

Deno.test("an OAuth token is accepted on /mcp", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assertEquals(answer.status, 200);
  assertEquals(answer.body.result.serverInfo.name, "vansen");
  assert(answer.body.result.capabilities.tools, "advertises tools");
  assertEquals(answer.headers.get("mcp-session-id"), null, "stateless: no session id");
});

Deno.test("a session token on /mcp gets 401 with WWW-Authenticate naming the PRM", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "tools/list", {}, { token: SESSION_JWT });
  assertEquals(answer.status, 401);
  const header = answer.headers.get("www-authenticate") ?? "";
  assertStringIncludes(header, "Bearer");
  assertStringIncludes(header, `resource_metadata="${PRM_URL}"`);
});

Deno.test("a bare /mcp call (no token) gets 401 with WWW-Authenticate", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "tools/list", {}, { token: null });
  assertEquals(answer.status, 401);
  assertStringIncludes(answer.headers.get("www-authenticate") ?? "", `resource_metadata="${PRM_URL}"`);
});

Deno.test("an invalid token on /mcp gets 401 invalid_token with WWW-Authenticate", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "tools/list", {}, { token: "expired-or-revoked" });
  assertEquals(answer.status, 401);
  const header = answer.headers.get("www-authenticate") ?? "";
  assertStringIncludes(header, 'error="invalid_token"');
  assertStringIncludes(header, `resource_metadata="${PRM_URL}"`);
});

Deno.test("the PRM is public and names the resource, the AS and the Supabase scopes", async () => {
  const { app } = mcpApp();
  const res = await app.request("/api/mcp/.well-known/oauth-protected-resource");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    resource: MCP_RESOURCE,
    authorization_servers: ["https://project.example/auth/v1"],
    scopes_supported: ["openid", "email"],
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
  const prm = await app.request("/api/mcp/.well-known/oauth-protected-resource");
  assertEquals(prm.status, 200);
});

Deno.test("MCP_ENABLED off does not touch the other routes' OAuth refusal", async () => {
  const deps = mcpDeps();
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const res = await createApp(deps).request("/api/profile", {
    headers: { authorization: `Bearer ${OAUTH_TOKEN}` },
  });
  assertEquals(res.status, 403);
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

Deno.test("an OAuth user who has not confirmed their age still reaches /mcp (tools refuse)", async () => {
  const { app, db } = mcpApp();
  db.tables.profiles = [{ id: db.tables.profiles[0].id, birth_date: null, strikes: 0, prefs: {} }];
  const answer = await rpc(app, "tools/list");
  assertEquals(answer.status, 200);
});

Deno.test("no app route accepts 'mcp' from the x-vansen-client header", async () => {
  const { app, db } = mcpApp();
  db.tables.subscriptions = [{ user_id: db.tables.profiles[0].id, plan: "pro", status: "active", current_period_end: "2099-01-01T00:00:00Z" }];
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
