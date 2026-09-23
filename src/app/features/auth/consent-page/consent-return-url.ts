/**
 * Restrict a caller-supplied return URL to our own OAuth consent page.
 *
 * A `returnUrl` query parameter is the classic open-redirect vector: a link to
 * our own login page with someone else's destination baked in ("sign in, then
 * we'll send you to https://evil.example"). The only legitimate use here is
 * "come back to the consent page after signing in", so anything else —
 * another origin, a protocol-relative URL, a different path — is refused
 * rather than trusted.
 */
export function safeConsentReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // A leading backslash is treated as a slash by some browsers, and a leading
  // "//" is a protocol-relative URL — both are ways to smuggle a foreign host
  // into something that otherwise looks like a path.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;

  let url: URL;
  try {
    url = new URL(raw, 'https://vansen.invalid');
  } catch {
    return null;
  }
  if (url.pathname !== '/oauth/consent') return null;
  return url.pathname + url.search;
}
