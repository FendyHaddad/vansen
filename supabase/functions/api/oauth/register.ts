// POST /oauth/register (RFC 7591): public clients only (no secret), one to five
// redirect URIs that pass redirectUriProblem(), an optional name of at most
// 100 characters, at most 20 registrations per hour per client IP (clientIp())
// and 500 per hour in total.
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

interface ClientIp {
  ip: string;
  source: "cf-connecting-ip" | "x-forwarded-for:last" | "none";
  forwardedHops: number;
}

/**
 * The caller's IP, from a hop the caller cannot write. Hosted requests reach
 * the function through Cloudflare and Supabase's gateway, which APPEND to an
 * incoming x-forwarded-for, so its first hop is whatever the caller sent.
 * Cloudflare overwrites cf-connecting-ip, so it wins when present; otherwise
 * the right-most x-forwarded-for hop, the one the nearest proxy appended. At
 * worst that hop is a proxy address shared by many callers: a tighter limit,
 * never a bypass, and the global cap in fn_oauth_register_client backs it.
 */
export function clientIp(header: (name: string) => string | undefined): ClientIp {
  const hops = (header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const cf = (header("cf-connecting-ip") ?? "").trim();
  if (cf) return { ip: cf, source: "cf-connecting-ip", forwardedHops: hops.length };
  const last = hops.at(-1);
  if (last) return { ip: last, source: "x-forwarded-for:last", forwardedHops: hops.length };
  return { ip: "unknown", source: "none", forwardedHops: 0 };
}

/** SHA-256 of the caller's IP. The log line names the header, never the IP,
 * so the hosted header chain can be confirmed from the function logs. */
async function clientIpHash(c: Context<Vars>): Promise<string> {
  const { ip, source, forwardedHops } = clientIp((name) => c.req.header(name));
  console.log(JSON.stringify({ event: "oauth_register", ipSource: source, forwardedHops }));
  return await sha256Hex(`ip:${ip}`);
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
  if (stored === "rate_limited_global") {
    return oauthError(c, 429, "rate_limited", "Too many registrations right now. Try again later.");
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
