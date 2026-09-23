// The session endpoints behind the web consent page and the Connected tab:
// request details, Allow, Deny, the grant list and Disconnect. They need the
// app's own session; the grant endpoints keep working with MCP_ENABLED off.
import { assert, assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { MCP_API, mcpApp, mcpDeps, OAUTH_CLIENT, OAUTH_TOKEN } from "./testing/mcp.ts";
import {
  approveCode,
  connect,
  mcpStatus,
  REDIRECT,
  registerClient,
  session,
  startAuthorization,
} from "./testing/oauth-flow.ts";

Deno.test("GET /oauth/requests/:id: what the consent page shows", async () => {
  const { app } = mcpApp();
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  const res = await session(app, "GET", `/oauth/requests/${id}`);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    clientName: "MCP Inspector",
    redirectUri: REDIRECT,
    redirectHost: "127.0.0.1:6276",
    scope: "vansen",
    alreadyGranted: false,
  });
  await approveCode(app, id);
  const second = await startAuthorization(app, clientId);
  const again = await (await session(app, "GET", `/oauth/requests/${second}`)).json();
  assertEquals(again.alreadyGranted, true, "an active grant lets the page auto-approve");
});

// Final review 2, C1: one approval showing a trusted host must not let the
// same client later take a code to another of its registered hosts silently.
Deno.test("alreadyGranted is bound to the redirect URI: approving host A never auto-approves host B", async () => {
  const { app } = mcpApp();
  const trusted = "https://claude.ai/api/mcp/auth_callback";
  const evil = "https://evil.example/cb";
  const clientId = await registerClient(app, [trusted, evil]);
  await approveCode(app, await startAuthorization(app, clientId, { redirect_uri: trusted }));

  const attack = await startAuthorization(app, clientId, { redirect_uri: evil });
  const shown = await (await session(app, "GET", `/oauth/requests/${attack}`)).json();
  assertEquals(shown.alreadyGranted, false, "a new redirect URI always shows the consent screen");
  assertEquals(shown.redirectHost, "evil.example");

  const again = await startAuthorization(app, clientId, { redirect_uri: trusted });
  assertEquals((await (await session(app, "GET", `/oauth/requests/${again}`)).json()).alreadyGranted, true);

  await approveCode(app, attack);
  const later = await startAuthorization(app, clientId, { redirect_uri: evil });
  assertEquals(
    (await (await session(app, "GET", `/oauth/requests/${later}`)).json()).alreadyGranted,
    true,
    "once the user approved host B on the screen, B reconnects silently too",
  );
  const { grants } = await (await session(app, "GET", "/oauth/grants")).json();
  const mine = grants.find((g: { clientId: string }) => g.clientId === clientId);
  assertEquals(mine.redirectHost, "claude.ai, evil.example", "the Connected tab names every approved host");
});

Deno.test("alreadyGranted: a revoked grant's approvals do not carry over", async () => {
  const { app } = mcpApp();
  const clientId = await registerClient(app);
  await approveCode(app, await startAuthorization(app, clientId));
  await session(app, "DELETE", `/oauth/grants/${clientId}`);
  const id = await startAuthorization(app, clientId);
  assertEquals((await (await session(app, "GET", `/oauth/requests/${id}`)).json()).alreadyGranted, false);
});

Deno.test("GET /oauth/requests/:id: unknown, malformed or expired is 404", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  for (const bad of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const res = await session(app, "GET", `/oauth/requests/${bad}`);
    assertEquals(res.status, 404, bad);
    assertEquals((await res.json()).error.code, "authorization_not_found");
  }
  db.setNow(new Date(db.now().getTime() + 601_000));
  assertEquals((await session(app, "GET", `/oauth/requests/${id}`)).status, 404);
  assertEquals((await session(app, "POST", `/oauth/requests/${id}/approve`)).status, 404);
});

Deno.test("approve: a code and the state go back to the client; the request is used up", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  const res = await session(app, "POST", `/oauth/requests/${id}/approve`);
  assertEquals(res.status, 200);
  const url = new URL((await res.json()).redirectUrl);
  assertEquals(`${url.origin}${url.pathname}`, REDIRECT);
  assert(url.searchParams.get("code")!.startsWith("vsn_ac_"));
  assertEquals(url.searchParams.get("state"), "st-1");
  assertEquals(url.searchParams.get("iss"), "https://vansen.vankode.com", "RFC 9207 iss");
  assertEquals(db.tables.oauth_requests.length, 0);
  assertEquals((await session(app, "POST", `/oauth/requests/${id}/approve`)).status, 404);
});

Deno.test("deny: access_denied and the state go back to the client", async () => {
  const { app, db } = mcpApp();
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  const res = await session(app, "POST", `/oauth/requests/${id}/deny`);
  assertEquals(res.status, 200);
  const url = new URL((await res.json()).redirectUrl);
  assertEquals(url.searchParams.get("error"), "access_denied");
  assertEquals(url.searchParams.get("state"), "st-1");
  assertEquals(url.searchParams.get("code"), null);
  assertEquals(url.searchParams.get("iss"), "https://vansen.vankode.com", "RFC 9207 iss");
  assertEquals(db.tables.oauth_requests.length, 0);
  assertEquals((await session(app, "POST", `/oauth/requests/${id}/deny`)).status, 404);
});

Deno.test("the consent endpoints need the app session: none, or an assistant token, is 401", async () => {
  const { app } = mcpApp();
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  for (const token of [null, OAUTH_TOKEN]) {
    assertEquals((await session(app, "GET", `/oauth/requests/${id}`, token)).status, 401);
    assertEquals((await session(app, "POST", `/oauth/requests/${id}/approve`, token)).status, 401);
    assertEquals((await session(app, "GET", "/oauth/grants", token)).status, 401);
  }
});

Deno.test("GET /oauth/grants lists active grants only", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  const res = await session(app, "GET", "/oauth/grants");
  assertEquals(res.status, 200);
  const { grants } = await res.json();
  assertEquals(grants.map((g: { clientId: string }) => g.clientId).sort(), [OAUTH_CLIENT, conn.clientId].sort());
  const mine = grants.find((g: { clientId: string }) => g.clientId === conn.clientId);
  assertEquals(mine.clientName, "MCP Inspector");
  assertEquals(mine.redirectHost, "127.0.0.1:6276");
  assert(mine.createdAt && mine.lastUsedAt);
  await session(app, "DELETE", `/oauth/grants/${conn.clientId}`);
  const after = await (await session(app, "GET", "/oauth/grants")).json();
  assertEquals(after.grants.map((g: { clientId: string }) => g.clientId), [OAUTH_CLIENT]);
});

Deno.test("DELETE /oauth/grants/:clientId revokes the grant and its tokens", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  assertEquals(await mcpStatus(app, conn.accessToken), 200);
  const res = await session(app, "DELETE", `/oauth/grants/${conn.clientId}`);
  assertEquals(res.status, 204);
  assertEquals(await mcpStatus(app, conn.accessToken), 401);
  assertEquals((await session(app, "DELETE", `/oauth/grants/${conn.clientId}`)).status, 404);
});

Deno.test("another user's grant cannot be revoked", async () => {
  const { app, db } = mcpApp();
  db.tokens.set("other-session", { id: "other-user", email: "o@example.com" });
  db.tables.profiles.push({ id: "other-user", birth_date: "1990-01-01", strikes: 0, prefs: {} });
  const res = await session(app, "DELETE", `/oauth/grants/${OAUTH_CLIENT}`, "other-session");
  assertEquals(res.status, 404);
  assertEquals(await mcpStatus(app, OAUTH_TOKEN), 200);
});

Deno.test("MCP_ENABLED off: consent endpoints 503, grant list and Disconnect still work", async () => {
  const deps = mcpDeps();
  const app = createApp(deps);
  const clientId = await registerClient(app);
  const id = await startAuthorization(app, clientId);
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  assertEquals((await session(app, "GET", `/oauth/requests/${id}`)).status, 503);
  assertEquals((await session(app, "POST", `/oauth/requests/${id}/approve`)).status, 503);
  assertEquals((await session(app, "GET", "/oauth/grants")).status, 200);
  assertEquals((await session(app, "DELETE", `/oauth/grants/${OAUTH_CLIENT}`)).status, 204);
});

Deno.test("the local metadata endpoint serves the same document shape, even when MCP is off", async () => {
  const deps = mcpDeps();
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const res = await createApp(deps).request("/api/oauth/.well-known/oauth-authorization-server", {
    headers: { origin: "https://claude.ai" },
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assertEquals(body.issuer, "https://vansen.vankode.com");
  assertEquals(body.token_endpoint, `${MCP_API}/oauth/token`);
});
