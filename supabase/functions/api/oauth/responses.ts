// Response and request shapes shared by the public OAuth endpoints: RFC 6749 /
// 7591 JSON errors (never cached), the plain 400 page for an authorize request
// we must not redirect, the MCP_ENABLED gate, and the form-body reader.
import type { Context } from "jsr:@hono/hono";
import type { ApiContext, Vars } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export function oauthError(
  c: Context<Vars>,
  status: 400 | 401 | 429 | 503,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

/** An authorize request we cannot trust enough to redirect: a plain page. */
export function refusalPage(c: Context<Vars>, reason: string): Response {
  return c.text(`Vansen couldn't start this sign-in: ${reason}\n`, 400, {
    ...NO_STORE,
    "x-content-type-options": "nosniff",
  });
}

/** The 503 when assistant connections are unconfigured or switched off. */
export function issuanceOff(c: Context<Vars>, ctx: ApiContext): Response | null {
  if (!ctx.deps.env.mcp) {
    return fail(c, 503, "mcp_unconfigured", "The assistant connection is not configured.");
  }
  if (!ctx.deps.env.releaseFlags.mcpEnabled) {
    return fail(c, 503, "mcp_disabled", "The assistant connection is switched off.");
  }
  return null;
}

/** An application/x-www-form-urlencoded body; anything else reads as empty. */
export async function formOf(c: Context<Vars>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return {};
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
}
