// GET /oauth/authorize: an unknown client, an unregistered redirect_uri or a
// bad parameter gets a plain 400 page and is never redirected to (RFC 9700
// §4.11.2: no instant redirects to a dynamically registered URI); success
// stores the request and sends the browser to the consent page on the
// issuer's origin, whatever order APP_ORIGIN lists.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { MCP_API, MCP_RESOURCE, mcpApp, mcpDeps } from "./testing/mcp.ts";
import { authorize, CHALLENGE, REDIRECT, registerClient } from "./testing/oauth-flow.ts";

Deno.test("authorize: 302 to the consent page with the stored request's id", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const res = await authorize(app, clientId);
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assertEquals(`${location.origin}${location.pathname}`, "https://vansen.vankode.com/oauth/consent");
  const id = location.searchParams.get("authorization_id");
  const row = db.tables.oauth_requests.find((r) => r.id === id)!;
  assertEquals(row.client_id, clientId);
  assertEquals(row.redirect_uri, REDIRECT);
  assertEquals(row.state, "st-1");
  assertEquals(row.code_challenge, CHALLENGE);
  assertEquals(row.scope, "vansen");
  assertEquals(row.resource, MCP_RESOURCE);
  assertEquals(new Date(String(row.expires_at)).getTime() - db.now().getTime(), 600_000);
});

Deno.test("authorize: an unknown client gets a 400 page, never a redirect", async () => {
  const { app } = mcpApp();
  const res = await authorize(app, "vsn_client_doesnotexist000000000");
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("location"), null);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/plain");
});

Deno.test("authorize: a redirect_uri that is not exactly registered is never redirected to", async () => {
  const { app } = mcpApp();
  const clientId = await registerClient(app);
  for (const uri of [`${REDIRECT}/x`, `${REDIRECT}?a=1`, "http://127.0.0.1:6277/oauth/callback", "https://evil.example/cb", null]) {
    const res = await authorize(app, clientId, { redirect_uri: uri });
    assertEquals(res.status, 400, String(uri));
    assertEquals(res.headers.get("location"), null, String(uri));
    await res.body?.cancel();
  }
});

Deno.test("authorize: hosted, consent is on the issuer origin whatever APP_ORIGIN lists first", async () => {
  const deps = mcpDeps();
  deps.env.appOrigins = ["https://preview.vansen.workers.dev", "https://vansen.vankode.com"];
  const app = createApp(deps);
  const res = await authorize(app, await registerClient(app));
  assert(res.headers.get("location")!.startsWith("https://vansen.vankode.com/oauth/consent?authorization_id="));
});

Deno.test("authorize: a local issuer with a path falls back to the first APP_ORIGIN", async () => {
  const deps = mcpDeps();
  deps.env.mcp = { ...deps.env.mcp!, issuer: `${MCP_API}/oauth` };
  deps.env.appOrigins = ["http://127.0.0.1:4200"];
  const app = createApp(deps);
  const res = await authorize(app, await registerClient(app));
  assert(res.headers.get("location")!.startsWith("http://127.0.0.1:4200/oauth/consent?authorization_id="));
});

Deno.test("authorize: no consent origin configured is a 503, never localhost", async () => {
  const deps = mcpDeps();
  deps.env.mcp = { ...deps.env.mcp!, issuer: `${MCP_API}/oauth` };
  deps.env.appOrigins = [];
  const app = createApp(deps);
  const res = await authorize(app, await registerClient(app));
  assertEquals(res.status, 503);
  assertEquals(res.headers.get("location"), null);
  await res.body?.cancel();
});

Deno.test("authorize: an unknown client is told to re-add the connector", async () => {
  const { app } = mcpApp();
  const res = await authorize(app, "vsn_client_doesnotexist000000000");
  assertStringIncludes(await res.text(), "Remove and re-add the connector");
});

Deno.test("authorize: a bad parameter gets the plain 400 page, not a redirect", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const cases: [Record<string, string | null>, string][] = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: null }, "invalid_request"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ resource: "https://evil.example/mcp" }, "invalid_target"],
    [{ state: "s".repeat(1025) }, "invalid_request"],
  ];
  for (const [over, expected] of cases) {
    const res = await authorize(app, clientId, over);
    assertEquals(res.status, 400, JSON.stringify(over));
    assertEquals(res.headers.get("location"), null, JSON.stringify(over));
    assertStringIncludes(await res.text(), expected, JSON.stringify(over));
  }
  assertEquals(db.tables.oauth_requests ?? [], [], "no refused request was stored");
});

Deno.test("authorize: resource is optional; any scope is narrowed to vansen", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const res = await authorize(app, clientId, { resource: null, scope: "openid email offline_access" });
  assertEquals(res.status, 302);
  assert(res.headers.get("location")!.startsWith("https://vansen.vankode.com/oauth/consent"));
  const row = db.tables.oauth_requests[0];
  assertEquals(row.scope, "vansen");
  assertEquals(row.resource, null);
});

Deno.test("authorize: MCP_ENABLED off answers 503", async () => {
  const deps = mcpDeps();
  const app = createApp(deps);
  const clientId = await registerClient(app);
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const res = await authorize(createApp(deps), clientId);
  assertEquals(res.status, 503);
  await res.body?.cancel();
});
