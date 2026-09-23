// The 401 an MCP client can act on: the gateway's error body plus a
// WWW-Authenticate header naming our PRM (error="invalid_token" when the
// token was ours but is unknown, expired or revoked, so clients refresh).
import type { Context } from "jsr:@hono/hono";
import type { Vars } from "./context.ts";
import type { McpEnv } from "./deps.ts";
import { fail } from "./http.ts";
import { wwwAuthenticate } from "../mcp/metadata.ts";

export function mcpChallenge(
  c: Context<Vars>,
  mcp: McpEnv | undefined,
  message: string,
  invalid = false,
): Response {
  const res = fail(c, 401, "unauthorized", message);
  res.headers.set("www-authenticate", wwwAuthenticate(mcp, invalid));
  return res;
}
