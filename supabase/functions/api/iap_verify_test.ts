// POST /iap/verify: a receipt that can never verify is a 422 the app finishes
// (it treats 400/403/404/422 as permanent); only a genuine upstream or
// database failure is a 503 it leaves open to retry.
import { assertEquals } from 'jsr:@std/assert';
import {
  VerificationException,
  VerificationStatus,
} from 'npm:@apple/app-store-server-library@1.6.0';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Shaped like a StoreKit JWS; the fake verifier decides what it means. */
const JWS = `${b64url({ alg: 'ES256', x5c: ['a', 'b', 'c'] })}.${
  b64url({ transactionId: 'tx_1', bundleId: 'com.vankode.vansenMobile' })
}.c2lnbmF0dXJl`;

function verifyWith(verify: (jws: string) => Promise<unknown>) {
  const calls: string[] = [];
  const deps = testDeps({
    appleVerifier: () => ({
      verifyAndDecodeTransaction: (jws: string) => {
        calls.push(jws);
        return verify(jws);
      },
    }) as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_apply_fulfillment = () => ({
    applied: true,
    replay: false,
    reason: null,
    credits: { plan: 0, pack: 1000 },
  });
  return { app: createApp(deps), db, calls };
}

function post(app: ReturnType<typeof createApp>, jws: string) {
  return app.request('/api/iap/verify', {
    method: 'POST',
    headers: { ...AUTH, 'x-vansen-client': 'ios' },
    body: JSON.stringify({ jws }),
  });
}

const PERMANENT: [string, () => unknown][] = [
  ['a sandbox receipt sent to the production verifier', () =>
    new VerificationException(VerificationStatus.INVALID_ENVIRONMENT)],
  ['a receipt for another bundle or app id', () =>
    new VerificationException(VerificationStatus.INVALID_APP_IDENTIFIER)],
  ['a chain that is not three certificates', () =>
    new VerificationException(VerificationStatus.INVALID_CHAIN_LENGTH)],
  ['an unparseable or expired certificate', () =>
    new VerificationException(VerificationStatus.INVALID_CERTIFICATE)],
  ['a chain that does not reach Apple Root CA G3', () =>
    new VerificationException(VerificationStatus.VERIFICATION_FAILURE)],
  ['a signature that does not match', () => {
    const cause = new Error('invalid signature');
    cause.name = 'JsonWebTokenError';
    return new VerificationException(VerificationStatus.VERIFICATION_FAILURE, cause);
  }],
];

for (const [label, error] of PERMANENT) {
  Deno.test(`/iap/verify: ${label} → 422 purchase_rejected, never 503`, async () => {
    const { app } = verifyWith(() => Promise.reject(error()));
    const res = await post(app, JWS);
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error.code, 'purchase_rejected');
  });
}

Deno.test('/iap/verify: a malformed JWS → 422 before the verifier runs', async () => {
  const { app, calls } = verifyWith(() => Promise.resolve({}));
  for (const jws of ['not-a-jws', 'a.b', 'x.y.z', `${b64url('str')}.${b64url({})}.sig`]) {
    const res = await post(app, jws);
    assertEquals(res.status, 422, jws);
    assertEquals((await res.json()).error.code, 'purchase_rejected');
  }
  assertEquals(calls, []);
});

Deno.test('/iap/verify: an unknown product → 422 (unchanged)', async () => {
  const { app } = verifyWith(() =>
    Promise.resolve({ appAccountToken: TEST_USER, productId: 'vansen.nope', transactionId: 'tx_1' })
  );
  const res = await post(app, JWS);
  assertEquals(res.status, 422);
});

Deno.test('/iap/verify: an OCSP network failure stays 503 retry_later', async () => {
  const cause = new Error('connect ECONNRESET');
  cause.name = 'FetchError';
  const { app } = verifyWith(() =>
    Promise.reject(new VerificationException(VerificationStatus.VERIFICATION_FAILURE, cause))
  );
  const res = await post(app, JWS);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'retry_later');
  assertEquals(res.headers.get('retry-after'), '10');
});

Deno.test('/iap/verify: an OCSP answer we could not use stays 503', async () => {
  const { app } = verifyWith(() =>
    Promise.reject(new VerificationException(VerificationStatus.FAILURE))
  );
  assertEquals((await post(app, JWS)).status, 503);
});

Deno.test('/iap/verify: a database failure while granting stays 503', async () => {
  const { app, db } = verifyWith(() =>
    Promise.resolve({
      appAccountToken: TEST_USER,
      productId: 'vansen.pack.s',
      transactionId: 'tx_1',
      originalTransactionId: 'tx_1',
    })
  );
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset');
  assertEquals((await post(app, JWS)).status, 503);
});
