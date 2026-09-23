// Test doubles for the /mcp surface: an opaque vsn_at_ access token seeded
// with its client and grant (as our authorization server issues), an app
// session JWT, a gateway with MCP switched on, and a JSON-RPC caller.
import type { Hono } from "jsr:@hono/hono";
import { createApp } from "../app.ts";
import type { ApiDeps } from "../app.ts";
import type { Vars } from "../lib/context.ts";
import { sha256Hex } from "../oauth/secrets.ts";
import { FakeDb, TEST_USER, testDeps } from "./fakes.ts";
import { installOauthRpcs } from "./oauth.ts";

export const OAUTH_CLIENT = "vsn_client_testclient0000000000";
export const OAUTH_GRANT = "99999999-2222-4333-8444-555555555555";
export const MCP_API = "https://project.example/functions/v1/api";
export const MCP_RESOURCE = `${MCP_API}/mcp`;
export const MCP_ISSUER = "https://vansen.vankode.com";

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A JWT-shaped token; the fake auth only checks it is registered. */
export function jwtWith(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

/** The assistant's access token: opaque, never known to GoTrue. */
export const OAUTH_TOKEN = `vsn_at_${"A".repeat(43)}`;
const OAUTH_TOKEN_HASH = await sha256Hex(OAUTH_TOKEN);
export const SESSION_JWT = jwtWith({ sub: TEST_USER, aud: "authenticated" });

/** Seeds a registered client, its active grant and a live access token. */
export function seedOauthGrant(db: FakeDb, userId = TEST_USER): void {
  installOauthRpcs(db);
  db.tables.oauth_clients = [{
    id: OAUTH_CLIENT,
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    registered_ip_hash: "seed",
    created_at: db.now().toISOString(),
  }];
  db.tables.oauth_grants = [{
    id: OAUTH_GRANT,
    user_id: userId,
    client_id: OAUTH_CLIENT,
    created_at: db.now().toISOString(),
    last_used_at: null,
    revoked_at: null,
  }];
  db.tables.oauth_tokens = [{
    token_hash: OAUTH_TOKEN_HASH,
    grant_id: OAUTH_GRANT,
    kind: "access",
    // Far off: tool tests move the clock by hours. Expiry has its own tests.
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    replaced_by: null,
  }];
}

/** testDeps with MCP on, both token kinds known, and instant sleeps. */
export function mcpDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  const base = testDeps();
  const db = base.admin as unknown as FakeDb;
  seedOauthGrant(db);
  db.tokens.set(SESSION_JWT, { id: TEST_USER, email: "test@example.com" });
  return {
    ...base,
    sleep: () => Promise.resolve(),
    env: {
      ...base.env,
      releaseFlags: { ...base.env.releaseFlags, mcpEnabled: true },
      mcp: { resourceUrl: MCP_RESOURCE, apiUrl: MCP_API, issuer: MCP_ISSUER },
    },
    ...over,
  };
}

export const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export interface RpcAnswer {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  headers: Headers;
}

let nextId = 1;

export interface CallOpts {
  token?: string | null;
  id?: number | string;
  headers?: Record<string, string>;
}

/** One JSON-RPC call to POST /api/mcp. */
export async function rpc(
  app: Hono<Vars>,
  method: string,
  params: Record<string, unknown> = {},
  opts: CallOpts = {},
): Promise<RpcAnswer> {
  const token = opts.token === undefined ? OAUTH_TOKEN : opts.token;
  const headers: Record<string, string> = { ...MCP_HEADERS, ...opts.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: opts.id ?? nextId++,
      method,
      params,
    }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/** tools/call, returning the CallToolResult. */
export async function callTool(
  app: Hono<Vars>,
  name: string,
  args: Record<string, unknown> = {},
  opts: CallOpts = {},
) {
  const answer = await rpc(app, "tools/call", { name, arguments: args }, opts);
  if (!answer.body?.result) {
    throw new Error(`tools/call ${name} failed: ${JSON.stringify(answer.body)}`);
  }
  return answer.body.result as {
    isError?: boolean;
    content: Array<Record<string, unknown> & { type: string }>;
  };
}

/** The text of a tool result's first text block. */
export function textOf(result: { content: Array<Record<string, unknown>> }): string {
  const block = result.content.find((b) => b.type === "text");
  return String(block?.text ?? "");
}

/** The JSON block a tool result's text ends with. */
// deno-lint-ignore no-explicit-any
export function jsonOf(result: { content: Array<Record<string, unknown>> }): any {
  const text = textOf(result);
  const start = text.indexOf("\n{");
  return JSON.parse(start >= 0 ? text.slice(start + 1) : text);
}

export function mcpApp(over: Partial<ApiDeps> = {}) {
  const deps = mcpDeps(over);
  const db = deps.admin as unknown as FakeDb;
  return { app: createApp(deps), db, deps };
}
