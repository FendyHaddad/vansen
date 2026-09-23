// POST /oauth/register (RFC 7591): public clients only (no secret), one to five
// redirect URIs that pass redirectUriProblem(), an optional name of at most
// 100 characters, and at most 20 registrations per hour per client IP.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "../lib/context.ts";
import { redirectUriProblem } from "./redirects.ts";
import { oauthError } from "./responses.ts";
import { randomClientId, sha256Hex } from "./secrets.ts";
import { UNAVAILABLE } from "./store.ts";

const MAX_NAME = 100;
const MAX_REDIRECTS = 5;

type Registration = { name: string; redirectUris: string[] } | { error: string; description: string };

function nameOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "Unnamed app";
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  const name = raw.trim();
  if (!name) return "Unnamed app";
  return name.length <= MAX_NAME ? name : null;
}

function redirectsOf(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REDIRECTS) {
    return `redirect_uris must list 1 to ${MAX_REDIRECTS} URIs`;
  }
  for (const uri of raw) {
    const problem = redirectUriProblem(uri);
    if (problem) return `${String(uri).slice(0, 200)}: ${problem}`;
  }
  return raw as string[];
}

export function parseRegistration(body: unknown): Registration {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_client_metadata", description: "The body must be a JSON object." };
  }
  const meta = body as Record<string, unknown>;
  const method = meta.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return { error: "invalid_client_metadata", description: "Only public clients (token_endpoint_auth_method none) are supported." };
  }
  const name = nameOf(meta.client_name);
  if (!name) {
    return { error: "invalid_client_metadata", description: `client_name must be text of at most ${MAX_NAME} characters.` };
  }
  const redirectUris = redirectsOf(meta.redirect_uris);
  if (typeof redirectUris === "string") return { error: "invalid_redirect_uri", description: redirectUris };
  return { name, redirectUris };
}

/** SHA-256 of the first x-forwarded-for hop: the client, as the edge saw it. */
async function clientIpHash(c: Context<Vars>): Promise<string> {
  const first = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim();
  return await sha256Hex(`ip:${first || "unknown"}`);
}

export async function handleRegister(c: Context<Vars>, ctx: ApiContext): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = parseRegistration(body);
  if ("error" in parsed) return oauthError(c, 400, parsed.error, parsed.description);
  const clientId = randomClientId();
  const stored = await ctx.oauth.registerClient(clientId, parsed.name, parsed.redirectUris, await clientIpHash(c));
  if (stored === "rate_limited") {
    return oauthError(c, 429, "rate_limited", "Too many registrations from this address. Try again later.");
  }
  if (stored === UNAVAILABLE) {
    return oauthError(c, 503, "temporarily_unavailable", "Registration is unavailable right now.");
  }
  return c.json({
    client_id: clientId,
    client_name: parsed.name,
    redirect_uris: parsed.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201, { "cache-control": "no-store" });
}
