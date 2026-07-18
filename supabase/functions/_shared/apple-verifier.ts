// Shared verifier for ASSNv2 payloads and transaction JWS. Trust anchor: the
// x5c chain must terminate at Apple Root CA G3. APPLE_ENV=Production requires
// APPLE_APP_ID (Apple's rule); sandbox does not.
import { Environment, SignedDataVerifier } from 'npm:@apple/app-store-server-library@1.6.0';
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
