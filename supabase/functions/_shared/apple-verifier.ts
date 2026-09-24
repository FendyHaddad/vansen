// Shared verifier for ASSNv2 payloads and transaction JWS. Trust anchor: the
// x5c chain must terminate at Apple Root CA G3. APPLE_ENV=Production requires
// APPLE_APP_ID (Apple's rule); sandbox does not.
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from 'npm:@apple/app-store-server-library@1.6.0';
import { Buffer } from 'node:buffer';
import { APPLE_ROOT_CA_G3_BASE64 } from './apple-roots.ts';

const BUNDLE_ID = Deno.env.get('APPLE_BUNDLE_ID') ?? 'com.vankode.vansenMobile';

export function appleVerifier(): SignedDataVerifier {
  const production = Deno.env.get('APPLE_ENV') === 'Production';
  const appAppleId = Number(Deno.env.get('APPLE_APP_ID') ?? '') || undefined;
  return new SignedDataVerifier(
    [Buffer.from(APPLE_ROOT_CA_G3_BASE64, 'base64')],
    true,
    production ? Environment.PRODUCTION : Environment.SANDBOX,
    BUNDLE_ID,
    appAppleId,
  );
}

/** Errors jsonwebtoken raises for a token that is simply not valid. */
const TOKEN_ERRORS = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);

/** Statuses that describe the receipt itself; retrying cannot change them. */
const RECEIPT_STATUSES = new Set<VerificationStatus>([
  VerificationStatus.INVALID_APP_IDENTIFIER,
  VerificationStatus.INVALID_ENVIRONMENT,
  VerificationStatus.INVALID_CHAIN_LENGTH,
  VerificationStatus.INVALID_CERTIFICATE,
]);

/**
 * True when the verifier refused the receipt for good: wrong environment
 * (a sandbox purchase against production), wrong bundle or app id, a bad
 * chain or certificate, a chain that does not reach Apple's root, or a
 * signature that does not match. False for what can pass on retry: an OCSP
 * lookup that failed on the network (VERIFICATION_FAILURE wrapping a fetch
 * error) or returned an answer we could not use (FAILURE).
 */
export function receiptNeverVerifies(error: unknown): boolean {
  if (!(error instanceof VerificationException)) return false;
  if (RECEIPT_STATUSES.has(error.status)) return true;
  if (error.status !== VerificationStatus.VERIFICATION_FAILURE) return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return true;
  return cause instanceof Error && TOKEN_ERRORS.has(cause.name);
}

function jsonObjectOf(part: string): boolean {
  try {
    const text = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** A compact JWS: three base64url parts, the first two JSON objects. Anything
 * else can never verify, so it is refused before the verifier runs. */
export function looksLikeJws(jws: string): boolean {
  const parts = jws.split('.');
  if (parts.length !== 3) return false;
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  return jsonObjectOf(parts[0]) && jsonObjectOf(parts[1]);
}
