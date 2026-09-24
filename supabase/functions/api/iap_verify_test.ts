// POST /iap/verify: a receipt that can never verify is a 422 the app finishes
// (it treats 400/403/404/422 as permanent); only a genuine upstream or
// database failure is a 503 it leaves open to retry. A sandbox receipt (App
// Review, TestFlight) is granted and recorded as sandbox, out of revenue.
import { assert, assertEquals } from 'jsr:@std/assert';
import {
  Environment,
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
  ['a receipt neither production nor sandbox accepts (e.g. Xcode)', () =>
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

const PACK_TX = {
  appAccountToken: TEST_USER,
  productId: 'vansen.pack.s',
  transactionId: 'tx_1',
  originalTransactionId: 'tx_1',
};

function grantCalls(db: FakeDb) {
  return db.rpcCalls.filter((c) => c.name === 'fn_apply_fulfillment');
}

/** Runs fn with console.info captured; returns the parsed JSON lines. */
async function infoLines(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const original = console.info;
  const lines: Record<string, unknown>[] = [];
  console.info = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])));
    } catch {
      // not a structured line
    }
  };
  try {
    await fn();
  } finally {
    console.info = original;
  }
  return lines;
}

Deno.test('/iap/verify: a production receipt is granted and recorded as production', async () => {
  const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.PRODUCTION }));
  const res = await post(app, JWS);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).outcome, 'applied');
  const calls = grantCalls(db);
  assertEquals(calls.length, 1);
  // Production is the column default; the argument is left out so this build
  // also runs against a database that predates 0038.
  assertEquals('p_environment' in calls[0].args, false);
});

Deno.test('/iap/verify: a sandbox receipt (App Review, TestFlight) is granted and recorded as sandbox', async () => {
  const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
  const res = await post(app, JWS);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.outcome, 'applied');
  assertEquals(body.granted, true);
  const calls = grantCalls(db);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.p_environment, 'sandbox');
  assertEquals(calls[0].args.p_txn_id, 'tx_1');
});

Deno.test('/iap/verify: a redelivered sandbox receipt is a replay, not a second grant', async () => {
  const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
  let applied = 0;
  db.rpcHandlers.fn_apply_fulfillment = () => {
    applied += 1;
    const replay = applied > 1;
    return { applied: !replay, replay, reason: null, credits: { plan: 0, pack: 1000 } };
  };
  assertEquals((await (await post(app, JWS)).json()).outcome, 'applied');
  assertEquals((await (await post(app, JWS)).json()).outcome, 'already_applied');
});

Deno.test('/iap/verify: logs one structured line naming the environment', async () => {
  const { app } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
  const lines = await infoLines(async () => await post(app, JWS));
  const line = lines.find((l) => l.event === 'iap_verified');
  assert(line, 'no iap_verified line');
  assertEquals(line.environment, 'sandbox');
  assertEquals(line.transactionId, 'tx_1');
  assertEquals(line.outcome, 'applied');
});

// ── I3: the owner's brake on sandbox grants ─────────────────────────────────

function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  return fn().finally(() => {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  });
}

Deno.test('/iap/verify: APPLE_SANDBOX_GRANTS=off refuses a sandbox receipt with 422 sandbox_disabled', () =>
  withEnv('APPLE_SANDBOX_GRANTS', 'off', async () => {
    const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
    const res = await post(app, JWS);
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error.code, 'sandbox_disabled');
    assertEquals(grantCalls(db), [], 'no grant call must be made while the brake is on');
  }));

Deno.test('/iap/verify: APPLE_SANDBOX_GRANTS=off is permanent, so the app finishes the transaction', () =>
  withEnv('APPLE_SANDBOX_GRANTS', 'off', async () => {
    // 422, not 503: retrying this receipt can never succeed while the flag is off.
    const { app } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
    assertEquals((await post(app, JWS)).status, 422);
  }));

Deno.test('/iap/verify: APPLE_SANDBOX_GRANTS=off never touches a production receipt', () =>
  withEnv('APPLE_SANDBOX_GRANTS', 'off', async () => {
    const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.PRODUCTION }));
    const res = await post(app, JWS);
    assertEquals(res.status, 200);
    assertEquals(grantCalls(db).length, 1);
  }));

Deno.test('/iap/verify: APPLE_SANDBOX_GRANTS unset still grants sandbox (the default is on)', () =>
  withEnv('APPLE_SANDBOX_GRANTS', undefined, async () => {
    const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
    const res = await post(app, JWS);
    assertEquals(res.status, 200);
    assertEquals(grantCalls(db).length, 1);
  }));

Deno.test('/iap/verify: APPLE_SANDBOX_GRANTS=on grants sandbox explicitly', () =>
  withEnv('APPLE_SANDBOX_GRANTS', 'on', async () => {
    const { app, db } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
    const res = await post(app, JWS);
    assertEquals(res.status, 200);
    assertEquals(grantCalls(db).length, 1);
  }));

Deno.test('/iap/verify: a refused sandbox receipt is logged', () =>
  withEnv('APPLE_SANDBOX_GRANTS', 'off', async () => {
    const { app } = verifyWith(() => Promise.resolve({ ...PACK_TX, environment: Environment.SANDBOX }));
    const lines = await infoLines(async () => await post(app, JWS));
    const line = lines.find((l) => l.event === 'iap_verify_sandbox_grants_disabled');
    assert(line, 'no iap_verify_sandbox_grants_disabled line');
    assertEquals(line.transactionId, 'tx_1');
  }));
