// Apple's rule for a server that receives both kinds of purchase: verify
// against production first, and only when production says the payload belongs
// to the sandbox verify it there. App Review and TestFlight buy in the sandbox
// against the production server.
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  Environment,
  VerificationException,
  VerificationStatus,
} from 'npm:@apple/app-store-server-library@1.6.0';
import { environmentOf, productionThenSandbox } from './apple-verifier.ts';

const refused = (status: VerificationStatus, cause?: Error) => () =>
  Promise.reject(new VerificationException(status, cause));

Deno.test('a production payload is accepted by production; sandbox is never asked', async () => {
  let sandboxCalls = 0;
  const out = await productionThenSandbox(
    () => Promise.resolve({ environment: Environment.PRODUCTION }),
    () => {
      sandboxCalls += 1;
      return Promise.resolve({ environment: Environment.SANDBOX });
    },
  );
  assertEquals(out, { environment: Environment.PRODUCTION });
  assertEquals(sandboxCalls, 0);
});

Deno.test('INVALID_ENVIRONMENT from production → the sandbox verifier decides', async () => {
  const out = await productionThenSandbox(
    refused(VerificationStatus.INVALID_ENVIRONMENT),
    () => Promise.resolve({ environment: Environment.SANDBOX }),
  );
  assertEquals(out, { environment: Environment.SANDBOX });
});

Deno.test('INVALID_APP_IDENTIFIER from production → sandbox (sandbox notifications carry no appAppleId)', async () => {
  const out = await productionThenSandbox(
    refused(VerificationStatus.INVALID_APP_IDENTIFIER),
    () => Promise.resolve({ environment: Environment.SANDBOX }),
  );
  assertEquals(out, { environment: Environment.SANDBOX });
});

Deno.test('a payload neither environment accepts is refused with the sandbox verdict', async () => {
  const error = await assertRejects(() =>
    productionThenSandbox(
      refused(VerificationStatus.INVALID_ENVIRONMENT),
      refused(VerificationStatus.INVALID_ENVIRONMENT),
    ), VerificationException);
  assertEquals(error.status, VerificationStatus.INVALID_ENVIRONMENT);
});

Deno.test('a bad chain or signature on production is final; sandbox is never asked', async () => {
  let sandboxCalls = 0;
  const sandbox = () => {
    sandboxCalls += 1;
    return Promise.resolve({});
  };
  await assertRejects(() =>
    productionThenSandbox(refused(VerificationStatus.VERIFICATION_FAILURE), sandbox), VerificationException);
  await assertRejects(() =>
    productionThenSandbox(refused(VerificationStatus.INVALID_CERTIFICATE), sandbox), VerificationException);
  assertEquals(sandboxCalls, 0);
});

Deno.test('a transient production failure is rethrown, not retried in sandbox', async () => {
  let sandboxCalls = 0;
  const cause = new Error('connect ECONNRESET');
  const error = await assertRejects(() =>
    productionThenSandbox(refused(VerificationStatus.VERIFICATION_FAILURE, cause), () => {
      sandboxCalls += 1;
      return Promise.resolve({});
    }), VerificationException);
  assertEquals(error.status, VerificationStatus.VERIFICATION_FAILURE);
  assertEquals(sandboxCalls, 0);
});

Deno.test('a transient sandbox failure is rethrown so the caller answers 503', async () => {
  const cause = new Error('connect ECONNRESET');
  const error = await assertRejects(() =>
    productionThenSandbox(
      refused(VerificationStatus.INVALID_ENVIRONMENT),
      refused(VerificationStatus.VERIFICATION_FAILURE, cause),
    ), VerificationException);
  assertEquals((error as { cause?: unknown }).cause, cause);
});

Deno.test('without a production verifier (APPLE_ENV not Production) only sandbox runs', async () => {
  const out = await productionThenSandbox(null, () => Promise.resolve({ environment: Environment.SANDBOX }));
  assertEquals(out, { environment: Environment.SANDBOX });
});

Deno.test('environmentOf reads the verified payload environment', () => {
  assertEquals(environmentOf({ environment: Environment.SANDBOX }), 'sandbox');
  assertEquals(environmentOf({ environment: Environment.PRODUCTION }), 'production');
});
