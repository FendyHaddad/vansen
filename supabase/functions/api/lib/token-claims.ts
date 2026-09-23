// Reads claims from an access token that auth.getUser() has ALREADY verified.
// oauthClientIdOf() returns the `client_id` Supabase's OAuth server stamps on
// assistant tokens (app sessions have none). Never call this on an
// unverified token: decoding is not verification.

function payloadOf(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)),
    );
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The OAuth grant's client id, or null for an app session token. */
export function oauthClientIdOf(verifiedToken: string): string | null {
  const clientId = payloadOf(verifiedToken)?.client_id;
  return typeof clientId === "string" && clientId ? clientId : null;
}
