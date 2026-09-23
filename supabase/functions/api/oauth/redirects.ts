// Redirect URIs: which ones a client may register (https, loopback http, or a
// custom app scheme that is not a script or local-content scheme), the host
// the consent page shows, and how a code or error is attached to one. The
// registered string is matched exactly; nothing here normalises it.

const BANNED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Real clients use about 60 characters; this bounds what one row can carry.
const MAX_URI_LENGTH = 512;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Why this redirect URI cannot be registered, or null when it can. */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URI_LENGTH) return "must be a URL";
  const url = parse(raw);
  if (!url) return "must be an absolute URL";
  if (url.hash) return "must not contain a fragment";
  if (url.username || url.password) return "must not contain credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol === "http:") return "http is allowed only on a loopback host";
  if (BANNED_SCHEMES.has(url.protocol)) return `the ${url.protocol} scheme is not allowed`;
  return null;
}

/** What the consent page and the Connected tab show for a redirect URI. */
export function redirectHost(raw: string): string {
  const url = parse(raw);
  if (!url) return "";
  return url.host || url.protocol.replace(/:$/, "");
}

/** The redirect URI with these query parameters added (nulls skipped). */
export function withParams(raw: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(raw);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.toString();
}
