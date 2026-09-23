// POST /oauth/token and /oauth/revoke: PKCE S256, single-use codes whose reuse
// revokes the grant, redirect and client binding, refresh rotation whose reuse
// revokes the grant, expiry, RFC 7009 revocation, and only hashes at rest.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { mcpApp, mcpDeps } from "./testing/mcp.ts";
import {
  approveCode,
  connect,
  mcpStatus,
  redeem,
  registerClient,
  startAuthorization,
  tokenRequest,
} from "./testing/oauth-flow.ts";

async function codeFor(app: ReturnType<typeof mcpApp>["app"]) {
  const clientId = await registerClient(app);
  return { clientId, code: await approveCode(app, await startAuthorization(app, clientId)) };
}

Deno.test("token: a code becomes an opaque token pair that /mcp accepts", async () => {
  const { app, db } = mcpApp();
  const { clientId, code } = await codeFor(app);
  const res = await redeem(app, clientId, code);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assertMatch(body.access_token, /^vsn_at_[A-Za-z0-9_-]{43}$/);
  assertMatch(body.refresh_token, /^vsn_rt_[A-Za-z0-9_-]{43}$/);
  assertEquals({ ...body, access_token: "", refresh_token: "" }, {
    access_token: "",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "",
    scope: "vansen",
  });
  assertEquals(await mcpStatus(app, body.access_token), 200);
  const stored = JSON.stringify(db.tables);
  for (const secret of [code, body.access_token, body.refresh_token]) {
    assert(!stored.includes(secret), "only hashes are stored");
  }
});

Deno.test("token: a PKCE verifier that does not match is invalid_grant", async () => {
  const { app } = mcpApp();
  const { clientId, code } = await codeFor(app);
  const res = await redeem(app, clientId, code, { code_verifier: "x".repeat(43) });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_grant");
  const bad = await redeem(app, clientId, code, { code_verifier: "short" });
  assertEquals((await bad.json()).error, "invalid_request");
});

Deno.test("token: a second use of a code revokes the whole grant", async () => {
  const { app } = mcpApp();
  const { clientId, code } = await codeFor(app);
  const first = await (await redeem(app, clientId, code)).json();
  assertEquals(await mcpStatus(app, first.access_token), 200);
  const again = await redeem(app, clientId, code);
  assertEquals(again.status, 400);
  assertEquals((await again.json()).error, "invalid_grant");
  assertEquals(await mcpStatus(app, first.access_token), 401, "the first redemption's token is dead");
  const refresh = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
  assertEquals((await refresh.json()).error, "invalid_grant");
});

Deno.test("token: the code is bound to its redirect_uri and client", async () => {
  const { app } = mcpApp();
  const { clientId, code } = await codeFor(app);
  const otherClient = await registerClient(app);
  const wrongRedirect = await redeem(app, clientId, code, { redirect_uri: "http://127.0.0.1:6276/other" });
  assertEquals((await wrongRedirect.json()).error, "invalid_grant");
  const wrongClient = await redeem(app, otherClient, code);
  assertEquals((await wrongClient.json()).error, "invalid_grant");
  const unknown = await redeem(app, "vsn_client_unknown00000000000000", code);
  assertEquals(unknown.status, 401);
  assertEquals((await unknown.json()).error, "invalid_client");
  assertEquals((await redeem(app, clientId, code)).status, 200, "refusals did not consume the code");
});

Deno.test("token: a code expires after 5 minutes", async () => {
  const { app, db } = mcpApp();
  const { clientId, code } = await codeFor(app);
  db.setNow(new Date(db.now().getTime() + 301_000));
  assertEquals((await (await redeem(app, clientId, code)).json()).error, "invalid_grant");
});

Deno.test("token: resource, when sent, must be the MCP URL", async () => {
  const { app } = mcpApp();
  const { clientId, code } = await codeFor(app);
  const res = await redeem(app, clientId, code, { resource: "https://evil.example/mcp" });
  assertEquals((await res.json()).error, "invalid_target");
});

Deno.test("refresh: rotates the pair; the old refresh token's reuse revokes the grant", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  const rotated = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId });
  assertEquals(rotated.status, 200);
  const pair = await rotated.json();
  assert(pair.refresh_token !== conn.refreshToken && pair.access_token !== conn.accessToken);
  assertEquals(await mcpStatus(app, pair.access_token), 200);
  const reuse = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId });
  assertEquals(reuse.status, 400);
  assertEquals((await reuse.json()).error, "invalid_grant");
  assertEquals(await mcpStatus(app, pair.access_token), 401, "reuse ended the grant");
  const newest = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: conn.clientId });
  assertEquals((await newest.json()).error, "invalid_grant");
});

/** Runs fn and returns the JSON log lines it printed. */
async function logsOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

Deno.test("reuse detection logs one structured line naming the grant (refresh and code)", async () => {
  const { app, db } = mcpApp();
  const conn = await connect(app);
  await (await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId })).body?.cancel();
  const grantId = db.tables.oauth_grants.find((g) => g.client_id === conn.clientId)!.id;
  const refreshLogs = await logsOf(async () => {
    await (await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId })).body?.cancel();
  });
  assertEquals(refreshLogs.filter((l) => l.event === "oauth_reuse"), [
    { event: "oauth_reuse", kind: "refresh", grantId, clientId: conn.clientId },
  ]);
  const codeLogs = await logsOf(async () => {
    await (await redeem(app, conn.clientId, conn.code)).body?.cancel();
  });
  assertEquals(codeLogs.filter((l) => l.event === "oauth_reuse"), [
    { event: "oauth_reuse", kind: "code", grantId, clientId: conn.clientId },
  ]);
  const quiet = await logsOf(async () => {
    await (await tokenRequest(app, { grant_type: "refresh_token", refresh_token: "vsn_rt_unknown", client_id: conn.clientId })).body?.cancel();
  });
  assertEquals(quiet.filter((l) => l.event === "oauth_reuse"), [], "a plain invalid_grant is not reuse");
});

Deno.test("refresh: another client cannot use the refresh token", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  const other = await registerClient(app);
  const res = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: other });
  assertEquals((await res.json()).error, "invalid_grant");
});

Deno.test("an access token expires after an hour", async () => {
  const { app, db } = mcpApp();
  const conn = await connect(app);
  db.setNow(new Date(db.now().getTime() + 3601_000));
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${conn.accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assertEquals(res.status, 401);
  assert((res.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'));
  await res.body?.cancel();
});

Deno.test("revoke: a refresh token ends the grant; unknown tokens still answer 200", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  const revoke = (token: string) =>
    app.request("/api/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: conn.clientId }).toString(),
    });
  assertEquals((await revoke("vsn_rt_nonsense")).status, 200);
  assertEquals((await revoke("")).status, 200);
  assertEquals(await mcpStatus(app, conn.accessToken), 200);
  assertEquals((await revoke(conn.refreshToken)).status, 200);
  assertEquals(await mcpStatus(app, conn.accessToken), 401);
});

Deno.test("revoke: an access token ends only itself", async () => {
  const { app } = mcpApp();
  const conn = await connect(app);
  const res = await app.request("/api/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: conn.accessToken }).toString(),
  });
  assertEquals(res.status, 200);
  assertEquals(await mcpStatus(app, conn.accessToken), 401);
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId });
  assertEquals(refreshed.status, 200, "the grant lives on");
});

Deno.test("token: malformed requests", async () => {
  const { app } = mcpApp();
  const clientId = await registerClient(app);
  const cases: [Record<string, string>, number, string][] = [
    [{}, 400, "invalid_request"],
    [{ grant_type: "password", client_id: clientId }, 400, "unsupported_grant_type"],
    [{ grant_type: "client_credentials", client_id: clientId }, 400, "unsupported_grant_type"],
    [{ grant_type: "authorization_code", client_id: clientId }, 400, "invalid_request"],
    [{ grant_type: "refresh_token", client_id: clientId }, 400, "invalid_request"],
    [{ grant_type: "refresh_token", refresh_token: "vsn_rt_x" }, 400, "invalid_request"],
  ];
  for (const [form, status, error] of cases) {
    const res = await tokenRequest(app, form);
    assertEquals(res.status, status, JSON.stringify(form));
    assertEquals((await res.json()).error, error, JSON.stringify(form));
  }
});

Deno.test("token: MCP_ENABLED off answers 503 on issuance", async () => {
  const deps = mcpDeps();
  const app = createApp(deps);
  const conn = await connect(app);
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const res = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: conn.refreshToken, client_id: conn.clientId });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, "mcp_disabled");
});
