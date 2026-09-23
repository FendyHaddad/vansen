// RFC 8414 authorization server metadata. The hosted copy is a static file on
// the web origin (public/.well-known/oauth-authorization-server); the api also
// serves it at <api>/oauth/.well-known/oauth-authorization-server for local
// runs. A drift test keeps the static file equal to buildAsMetadata().

/** The hosted issuer: the web origin, where the static metadata lives. */
export const DEFAULT_ISSUER = "https://vansen.vankode.com";

/** The only scope: act on the user's Vansen account through /mcp. */
export const OAUTH_SCOPE = "vansen";

/** Key order matches the static file, so the two read the same. */
export function buildAsMetadata(issuer: string, apiUrl: string) {
  return {
    issuer,
    authorization_endpoint: `${apiUrl}/oauth/authorize`,
    token_endpoint: `${apiUrl}/oauth/token`,
    registration_endpoint: `${apiUrl}/oauth/register`,
    revocation_endpoint: `${apiUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  };
}
