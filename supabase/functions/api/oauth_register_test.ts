// POST /oauth/register (RFC 7591): public clients only, redirect URI rules
// (https, loopback http, safe custom schemes, at most 512 characters), name
// limits, 20 per hour per IP (the platform-appended hop) and 500 in total, the
// MCP_ENABLED switch and CORS for any origin.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { mcpApp, mcpDeps } from "./testing/mcp.ts";
import { REDIRECT, register } from "./testing/oauth-flow.ts";

Deno.test("register: 201 with a public client, stored with an IP hash, never the IP", async () => {
  const { app, db } = mcpApp();
  const res = await register(app, { client_name: "Claude", redirect_uris: [REDIRECT] });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertMatch(body.client_id, /^vsn_client_[A-Za-z0-9_-]{22}$/);
  assertEquals(body, {
    client_id: body.client_id,
    client_name: "Claude",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const row = db.tables.oauth_clients.find((c) => c.id === body.client_id)!;
  assertMatch(String(row.registered_ip_hash), /^[0-9a-f]{64}$/);
  assert(!JSON.stringify(row).includes("203.0.113.7"), "the IP itself is not stored");
});

Deno.test("register: a confidential client is refused", async () => {
  const { app } = mcpApp();
  const res = await register(app, {
    client_name: "x",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "client_secret_basic",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_client_metadata");
});

Deno.test("register: the redirect URI rules", async () => {
  const { app } = mcpApp();
  const accepted = [
    "https://claude.ai/api/mcp/auth_callback",
    "http://127.0.0.1:6276/oauth/callback",
    "http://localhost:3000/cb",
    "http://[::1]:8080/cb",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
  ];
  for (const uri of accepted) {
    const res = await register(app, { client_name: "x", redirect_uris: [uri] }, { "x-forwarded-for": uri });
    assertEquals(res.status, 201, uri);
  }
  const refused = [
    "http://example.com/cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vbscript:x",
    "about:blank",
    "blob:https://x/y",
    "https://claude.ai/cb#frag",
    "https://user:pw@claude.ai/cb",
    "not a url",
  ];
  for (const uri of refused) {
    const res = await register(app, { client_name: "x", redirect_uris: [uri] });
    assertEquals(res.status, 400, uri);
    assertEquals((await res.json()).error, "invalid_redirect_uri", uri);
  }
});

Deno.test("register: one to five redirect URIs", async () => {
  const { app } = mcpApp();
  for (const uris of [[], Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`), "https://a.example"]) {
    const res = await register(app, { client_name: "x", redirect_uris: uris });
    assertEquals(res.status, 400, JSON.stringify(uris));
    assertEquals((await res.json()).error, "invalid_redirect_uri");
  }
});

Deno.test("register: client_name is optional, at most 100 characters, no control characters", async () => {
  const { app } = mcpApp();
  const unnamed = await register(app, { redirect_uris: [REDIRECT] });
  assertEquals(unnamed.status, 201);
  assertEquals((await unnamed.json()).client_name, "Unnamed app");
  for (const name of ["x".repeat(101), "bad\u0007name", 42]) {
    const res = await register(app, { client_name: name, redirect_uris: [REDIRECT] });
    assertEquals(res.status, 400, String(name));
    assertEquals((await res.json()).error, "invalid_client_metadata");
  }
});

Deno.test("register: a body that is not a JSON object is refused", async () => {
  const { app } = mcpApp();
  for (const body of ["{nope", "[]", "null"]) {
    const res = await register(app, body);
    assertEquals(res.status, 400, body);
    assertEquals((await res.json()).error, "invalid_client_metadata");
  }
});

Deno.test("register: 20 per hour per client IP, then 429; another IP is unaffected", async () => {
  const { app, db } = mcpApp();
  for (let i = 0; i < 20; i++) {
    const res = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "198.51.100.1" });
    assertEquals(res.status, 201, `registration ${i + 1}`);
  }
  const limited = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "198.51.100.1" });
  assertEquals(limited.status, 429);
  assertEquals((await limited.json()).error, "rate_limited");
  const other = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "198.51.100.2" });
  assertEquals(other.status, 201);
  db.setNow(new Date(db.now().getTime() + 3601_000));
  const later = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "198.51.100.1" });
  assertEquals(later.status, 201, "the window slides");
});

// Final review 2, I2: proxies append to x-forwarded-for, so its first hop is
// whatever the caller sent. Only the hop the platform appended counts.
Deno.test("register: a spoofed x-forwarded-for first hop does not buy a fresh bucket", async () => {
  const { app } = mcpApp();
  for (let i = 0; i < 20; i++) {
    const res = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` });
    assertEquals(res.status, 201, `registration ${i + 1}`);
  }
  const spoofed = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "10.9.9.9, 198.51.100.9" });
  assertEquals(spoofed.status, 429);
  await spoofed.body?.cancel();
});

Deno.test("register: cf-connecting-ip, which Cloudflare overwrites, wins over x-forwarded-for", async () => {
  const { app } = mcpApp();
  for (let i = 0; i < 20; i++) {
    const res = await register(app, { redirect_uris: [REDIRECT] }, {
      "cf-connecting-ip": "198.51.100.20",
      "x-forwarded-for": `198.51.100.${100 + i}`,
    });
    assertEquals(res.status, 201, `registration ${i + 1}`);
  }
  const limited = await register(app, { redirect_uris: [REDIRECT] }, {
    "cf-connecting-ip": "198.51.100.20",
    "x-forwarded-for": "198.51.100.250",
  });
  assertEquals(limited.status, 429);
  await limited.body?.cancel();
});

Deno.test("register: 500 per hour in total, whatever the IP, then 429", async () => {
  const { app, db } = mcpApp();
  for (let i = 0; i < 500; i++) {
    db.tables.oauth_clients.push({
      id: `vsn_client_bulk${String(i).padStart(18, "0")}`, client_name: "x", redirect_uris: [REDIRECT],
      registered_ip_hash: `ip-${i}`, created_at: db.now().toISOString(),
    });
  }
  const res = await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "198.51.100.77" });
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, "rate_limited");
  assertMatch(body.error_description, /Too many registrations/);
});

Deno.test("register: a redirect URI longer than 512 characters is refused", async () => {
  const { app } = mcpApp();
  const long = `https://claude.ai/${"a".repeat(500)}`;
  const res = await register(app, { redirect_uris: [long] });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_redirect_uri");
  const fits = await register(app, { redirect_uris: [`https://claude.ai/${"a".repeat(400)}`] });
  assertEquals(fits.status, 201);
  await fits.body?.cancel();
});

Deno.test("register: logs which header gave the IP, never the IP", async () => {
  const { app } = mcpApp();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  try {
    await (await register(app, { redirect_uris: [REDIRECT] }, { "x-forwarded-for": "10.1.1.1, 198.51.100.5" })).body?.cancel();
  } finally {
    console.log = original;
  }
  const line = lines.map((l) => JSON.parse(l)).find((l) => l.event === "oauth_register");
  assertEquals(line, { event: "oauth_register", ipSource: "x-forwarded-for:last", forwardedHops: 2 });
  assert(!lines.join("").includes("198.51.100.5") && !lines.join("").includes("10.1.1.1"));
});

Deno.test("register: MCP_ENABLED off answers 503 mcp_disabled", async () => {
  const deps = mcpDeps();
  deps.env.releaseFlags = { ...deps.env.releaseFlags, mcpEnabled: false };
  const res = await register(createApp(deps), { redirect_uris: [REDIRECT] });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, "mcp_disabled");
});

Deno.test("register: CORS allows any origin, without credentials", async () => {
  const { app } = mcpApp();
  const res = await register(app, { redirect_uris: [REDIRECT] }, { origin: "https://claude.ai" });
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});
