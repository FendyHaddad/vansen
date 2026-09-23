// The authorization server's routes (relative to the /api base path) and which
// of them are public: the ones an MCP client calls before it has a token. The
// public ones get CORS `*`; the session ones keep the app's origin rules.

export const AS_METADATA_PATH = "/oauth/.well-known/oauth-authorization-server";

const PUBLIC_PATHS = new Set(
  [AS_METADATA_PATH, "/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"]
    .map((p) => `/api${p}`),
);

/** c.req.path (decoded, with the /api base) is a public OAuth endpoint. */
export function isPublicOauthPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}
