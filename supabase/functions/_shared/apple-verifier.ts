// Shared verifier for ASSNv2 payloads and transaction JWS. Trust anchor: the
// x5c chain must terminate at Apple Root CA G3.
//
// APPLE_ENV=Production verifies the way Apple asks a production server to:
// production first, and only when production says the payload belongs to the
// sandbox, the sandbox verifier (same root, same bundle id). App Review and
// TestFlight buy in the sandbox against the production server; those purchases
// are granted and recorded as `sandbox`, which keeps them out of revenue.
// Production requires APPLE_APP_ID (Apple's rule); sandbox does not. Any other
// APPLE_ENV verifies in the sandbox only.
import {
  Environment,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from 'npm:@apple/app-store-server-library@1.6.0';
import { Buffer } from 'node:buffer';
import { APPLE_ROOT_CA_G3_BASE64 } from './apple-roots.ts';

const BUNDLE_ID = Deno.env.get('APPLE_BUNDLE_ID') ?? 'com.vankode.vansenMobile';

/** billing_transactions.environment. */
export type AppleEnvironment = 'production' | 'sandbox';

export interface AppleVerifier {
  verifyAndDecodeTransaction(jws: string): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
}

// One SignedDataVerifier per environment, reused for the life of the process.
// A fresh instance discards the library's own verified-key cache, so every
// call would pay for an OCSP lookup again -- doubling the transient-503
// surface now that a sandbox payload can also be checked against production
// first. The two verifiers never change (Apple's root, our bundle id and app
// id are fixed for the process), so caching them is safe.
const verifierCache = new Map<Environment, SignedDataVerifier>();

function verifierFor(environment: Environment): SignedDataVerifier {
  const cached = verifierCache.get(environment);
  if (cached) return cached;
  const appAppleId = Number(Deno.env.get('APPLE_APP_ID') ?? '') || undefined;
  const verifier = new SignedDataVerifier(
    [Buffer.from(APPLE_ROOT_CA_G3_BASE64, 'base64')],
    true,
    environment,
    BUNDLE_ID,
    environment === Environment.PRODUCTION ? appAppleId : undefined,
  );
  verifierCache.set(environment, verifier);
  return verifier;
}

/**
 * Production's ways of saying "this is not a production payload":
 * INVALID_ENVIRONMENT (the payload names Sandbox), and INVALID_APP_IDENTIFIER,
 * which production checks first and a sandbox notification fails because it
 * carries no appAppleId. The sandbox verifier checks the chain, the bundle id
 * and the environment again, so falling back never accepts anything wider
 * than an Apple-signed sandbox payload for this app.
 */
function belongsToSandbox(error: unknown): boolean {
  if (!(error instanceof VerificationException)) return false;
  return error.status === VerificationStatus.INVALID_ENVIRONMENT ||
    error.status === VerificationStatus.INVALID_APP_IDENTIFIER;
}

/**
 * Production first; sandbox only when production refused the payload as a
 * sandbox one. Everything else production throws, including a transient OCSP
 * failure, is rethrown unchanged, so the caller's 422/503 split still holds.
 * `production` is null when this server verifies in the sandbox only.
 */
export async function productionThenSandbox<T>(
  production: (() => Promise<T>) | null,
  sandbox: () => Promise<T>,
): Promise<T> {
  if (!production) return await sandbox();
  try {
    return await production();
  } catch (error) {
    if (!belongsToSandbox(error)) throw error;
    try {
      return await sandbox();
    } catch (sandboxError) {
      // The thrown status is the sandbox verdict, which can mislead: a
      // production payload refused for a wrong APPLE_APP_ID is reported as
      // INVALID_ENVIRONMENT once sandbox also refuses it. Record what
      // production actually said as a side property rather than overwriting
      // `.cause` -- VerificationException already uses `.cause` for the
      // sandbox verdict's own OCSP failure, which receiptNeverVerifies reads.
      if (sandboxError instanceof Error) {
        (sandboxError as Error & { productionStatus?: unknown }).productionStatus =
          error instanceof VerificationException ? error.status : error;
      }
      throw sandboxError;
    }
  }
}

export function appleVerifier(): AppleVerifier {
  const production = Deno.env.get('APPLE_ENV') === 'Production';
  const inProduction = <T>(run: (v: SignedDataVerifier) => Promise<T>) =>
    production ? () => run(verifierFor(Environment.PRODUCTION)) : null;
  const inSandbox = <T>(run: (v: SignedDataVerifier) => Promise<T>) => () =>
    run(verifierFor(Environment.SANDBOX));
  return {
    verifyAndDecodeTransaction: (jws) => {
      const run = (v: SignedDataVerifier) => v.verifyAndDecodeTransaction(jws);
      return productionThenSandbox(inProduction(run), inSandbox(run));
    },
    verifyAndDecodeNotification: (signedPayload) => {
      const run = (v: SignedDataVerifier) => v.verifyAndDecodeNotification(signedPayload);
      return productionThenSandbox(inProduction(run), inSandbox(run));
    },
  };
}

/**
 * The environment of a VERIFIED payload. The library refuses any payload whose
 * environment differs from its verifier's, so this is the verifier that
 * accepted it.
 */
export function environmentOf(payload: { environment?: string } | null | undefined): AppleEnvironment {
  return payload?.environment === Environment.SANDBOX ? 'sandbox' : 'production';
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
 * True when the verifier refused the receipt for good: an environment neither
 * verifier accepts (Xcode, local testing), wrong bundle or app id, a bad
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

/**
 * Compact, payload-free description of a verification failure, safe to log.
 * Includes the production status productionThenSandbox recorded when the
 * sandbox fallback also refused the payload, so a misconfiguration (for
 * example APPLE_ENV=Production with no APPLE_APP_ID, which throws a plain
 * Error from the SignedDataVerifier constructor rather than a
 * VerificationException) still shows up instead of a bare 401.
 */
export function verifierErrorSummary(error: unknown): Record<string, unknown> {
  const productionStatus = (error as { productionStatus?: unknown } | null)?.productionStatus;
  return {
    name: error instanceof Error ? error.name : typeof error,
    status: error instanceof VerificationException ? String(error.status) : null,
    message: error instanceof Error ? error.message : String(error),
    ...(productionStatus !== undefined ? { productionStatus: String(productionStatus) } : {}),
  };
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
