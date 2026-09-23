// What an MCP client discovers before it has a token: the Protected Resource
// Metadata (RFC 9728) and the 401 WWW-Authenticate header that points at it.
// The PRM lives at <resource>/.well-known/oauth-protected-resource; the
// resource must equal the MCP URL exactly, since clients compare the two.
// mcpEnvFrom() decides the public URLs and the issuer from the environment.
import type { McpEnv } from "../lib/deps.ts";
import { DEFAULT_ISSUER, OAUTH_SCOPE } from "../oauth/metadata.ts";

export const MCP_PATH = "/api/mcp";
export const PRM_SUFFIX = "/.well-known/oauth-protected-resource";

export function protectedResourceMetadata(env: McpEnv) {
  return {
    resource: env.resourceUrl,
    authorization_servers: [env.issuer],
    scopes_supported: [OAUTH_SCOPE],
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

const trimmed = (url: string | undefined) => (url || "").replace(/\/$/, "");

/**
 * Where assistants reach /mcp and sign in. Hosted, the api URL derives from
 * SUPABASE_URL and the issuer is the web origin. Inside `supabase functions
 * serve` SUPABASE_URL is http://kong:8000, which no client resolves, so a local
 * run sets MCP_PUBLIC_SUPABASE_URL (e.g. http://127.0.0.1:54321) and may set
 * MCP_ISSUER (default <local api>/oauth). Both are ignored anywhere else, so a
 * stray hosted secret cannot repoint the PRM, the issuer or the endpoints.
 */
export function mcpEnvFrom(get: (k: string) => string | undefined): McpEnv | undefined {
  const supabaseUrl = trimmed(get("SUPABASE_URL"));
  const local = hostOf(supabaseUrl) === LOCAL_KONG_HOST;
  const base = local ? trimmed(get("MCP_PUBLIC_SUPABASE_URL")) || supabaseUrl : supabaseUrl;
  if (!base) return undefined;
  const apiUrl = `${base}/functions/v1/api`;
  const issuer = local ? trimmed(get("MCP_ISSUER")) || `${apiUrl}/oauth` : DEFAULT_ISSUER;
  return { resourceUrl: `${apiUrl}/mcp`, apiUrl, issuer };
}

/** The 401 challenge. `invalid` adds error="invalid_token" so clients refresh. */
export function wwwAuthenticate(env: McpEnv | undefined, invalid = false): string {
  const parts = [];
  if (invalid) parts.push('error="invalid_token"');
  if (env) parts.push(`resource_metadata="${env.resourceUrl}${PRM_SUFFIX}"`);
  return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer";
}
