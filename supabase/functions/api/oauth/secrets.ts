// Opaque OAuth secrets (Web Crypto only): 32 random bytes, base64url, with a
// prefix that says what they are. The database stores only sha256Hex() of a
// token or code; s256() is the PKCE transform of a code_verifier (RFC 7636).
// None of these is a JWT, so GoTrue refuses every one of them.

export const ACCESS_PREFIX = "vsn_at_";
export const REFRESH_PREFIX = "vsn_rt_";
export const CODE_PREFIX = "vsn_ac_";
export const CLIENT_PREFIX = "vsn_client_";

export const ACCESS_TTL_SECONDS = 3600;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** prefix + 32 random bytes (base64url, 43 chars). */
export function randomSecret(prefix: string, bytes = 32): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A client id: shorter, since it is public. */
export function randomClientId(): string {
  return randomSecret(CLIENT_PREFIX, 16);
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** What the database stores in place of a token or code. */
export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export async function s256(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
export function isCodeVerifier(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
}

/** A well-formed secret of this kind (prefix + base64url body). */
export function hasShape(v: unknown, prefix: string): v is string {
  return typeof v === "string" && v.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{43}$/.test(v.slice(prefix.length));
}
