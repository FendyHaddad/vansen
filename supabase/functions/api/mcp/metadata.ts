// What an MCP client discovers before it has a token: the Protected Resource
// Metadata (RFC 9728) and the 401 WWW-Authenticate header that points at it.
// The PRM lives at <resource>/.well-known/oauth-protected-resource; the
// resource must equal the MCP URL exactly, since clients compare the two.
import type { McpEnv } from "../lib/deps.ts";

export const MCP_PATH = "/api/mcp";
export const PRM_SUFFIX = "/.well-known/oauth-protected-resource";

/** Supabase's OAuth server only knows OIDC scopes; anything else is refused. */
export const MCP_SCOPES = ["openid", "email"];

export function protectedResourceMetadata(env: McpEnv) {
  return {
    resource: env.resourceUrl,
    authorization_servers: [env.authServerUrl],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Vansen",
  };
}

/** The 401 challenge. `invalid` adds error="invalid_token" so clients refresh. */
export function wwwAuthenticate(env: McpEnv | undefined, invalid = false): string {
  const parts = [];
  if (invalid) parts.push('error="invalid_token"');
  if (env) parts.push(`resource_metadata="${env.resourceUrl}${PRM_SUFFIX}"`);
  return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer";
}
