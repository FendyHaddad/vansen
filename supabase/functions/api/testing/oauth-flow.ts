// Drives the authorization server over app.request, the way an MCP client and
// the consent page would: register → authorize → approve → token. Each step is
// exported so a test can stop at any point and do something hostile instead.
import type { Hono } from "jsr:@hono/hono";
import type { Vars } from "../lib/context.ts";
import { s256 } from "../oauth/secrets.ts";
import { MCP_RESOURCE, SESSION_JWT } from "./mcp.ts";

type App = Hono<Vars>;

export const REDIRECT = "http://127.0.0.1:6276/oauth/callback";
/** RFC 7636 appendix B's verifier. */
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CHALLENGE = await s256(VERIFIER);

export function register(app: App, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function registerClient(app: App, redirectUris = [REDIRECT]): Promise<string> {
  const res = await register(app, { client_name: "MCP Inspector", redirect_uris: redirectUris });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
  return (await res.json()).client_id;
}

export function authorizeQuery(clientId: string, over: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "vansen",
    resource: MCP_RESOURCE,
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null) q.set(k, v);
  }
  return q.toString();
}

export function authorize(app: App, clientId: string, over: Record<string, string | null> = {}) {
  return app.request(`/api/oauth/authorize?${authorizeQuery(clientId, over)}`);
}

/** Authorize and return the authorization_id from the consent redirect. */
export async function startAuthorization(app: App, clientId: string): Promise<string> {
  const res = await authorize(app, clientId);
  const location = res.headers.get("location") ?? "";
  const id = new URL(location).searchParams.get("authorization_id");
  if (res.status !== 302 || !id) throw new Error(`authorize: ${res.status} ${location}`);
  return id;
}

export function session(app: App, method: string, path: string, token: string | null = SESSION_JWT) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(`/api${path}`, { method, headers });
}

/** Approve as the signed-in user; returns the code from the redirect URL. */
export async function approveCode(app: App, authorizationId: string): Promise<string> {
  const res = await session(app, "POST", `/oauth/requests/${authorizationId}/approve`);
  if (res.status !== 200) throw new Error(`approve: ${res.status} ${await res.text()}`);
  return new URL((await res.json()).redirectUrl).searchParams.get("code")!;
}

export function tokenRequest(app: App, form: Record<string, string>) {
  return app.request("/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

export function redeem(app: App, clientId: string, code: string, over: Record<string, string> = {}) {
  return tokenRequest(app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
    ...over,
  });
}

export interface Connection {
  clientId: string;
  code: string;
  accessToken: string;
  refreshToken: string;
}

/** The whole flow: a fresh client connected for TEST_USER. */
export async function connect(app: App): Promise<Connection> {
  const clientId = await registerClient(app);
  const code = await approveCode(app, await startAuthorization(app, clientId));
  const res = await redeem(app, clientId, code);
  if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { clientId, code, accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** tools/list with this bearer: the status /mcp answers. */
export async function mcpStatus(app: App, token: string): Promise<number> {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  await res.body?.cancel();
  return res.status;
}
