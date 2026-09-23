// What an MCP client discovers before it has a token: the Protected Resource
// Metadata (RFC 9728) and the 401 WWW-Authenticate header that points at it.
// The PRM lives at <resource>/.well-known/oauth-protected-resource; the
// resource must equal the MCP URL exactly, since clients compare the two.
// mcpEnvFrom() decides the public URLs from the environment.
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

/** The local Edge runtime's own name for Supabase; no client resolves it. */
const LOCAL_KONG_HOST = "kong";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Where assistants reach /mcp and sign in. Hosted, both derive from
 * SUPABASE_URL. Inside `supabase functions serve` SUPABASE_URL is
 * http://kong:8000, so a local run sets MCP_PUBLIC_SUPABASE_URL (e.g.
 * http://127.0.0.1:54321); it is ignored anywhere else, so a stray hosted
 * secret cannot repoint the PRM.
 */
export function mcpEnvFrom(get: (k: string) => string | undefined): McpEnv | undefined {
  const supabaseUrl = get("SUPABASE_URL") || "";
  const override = get("MCP_PUBLIC_SUPABASE_URL") || "";
  const local = hostOf(supabaseUrl) === LOCAL_KONG_HOST;
  const base = (local && override ? override : supabaseUrl).replace(/\/$/, "");
  if (!base) return undefined;
  return {
    resourceUrl: `${base}/functions/v1/api/mcp`,
    authServerUrl: `${base}/auth/v1`,
  };
}

/** The 401 challenge. `invalid` adds error="invalid_token" so clients refresh. */
export function wwwAuthenticate(env: McpEnv | undefined, invalid = false): string {
  const parts = [];
  if (invalid) parts.push('error="invalid_token"');
  if (env) parts.push(`resource_metadata="${env.resourceUrl}${PRM_SUFFIX}"`);
  return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer";
}
