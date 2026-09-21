// api-specific test doubles. The database/storage fakes live in _shared so the
// webhook functions can use the same ones.
export {
  FakeDb,
  FakeStorage,
  OTHER_USER,
  TEST_USER,
} from "../_shared/testing/fakes.ts";
export type {
  FakeError,
  FakeResult,
  Row,
  StoredObject,
} from "../_shared/testing/fakes.ts";

import { FakeDb, TEST_USER } from "../_shared/testing/fakes.ts";
import type { ApiDeps } from "../app.ts";
import type { ModerationDecision } from "../_shared/moderation.ts";
import type {
  CheckResult,
  ProviderAdapter,
  SubmitCtx,
} from "../_shared/providers/types.ts";

export interface FakeAdapter {
  adapter: ProviderAdapter;
  submits: SubmitCtx[];
  checks: string[];
  cancels: string[];
}

/** Records every call; answers with whatever the test queues up. */
export function fakeAdapter(opts?: {
  submit?: (
    ctx: SubmitCtx,
  ) => Promise<{ providerRef: string; inline?: CheckResult }>;
  check?: CheckResult;
}): FakeAdapter {
  const submits: SubmitCtx[] = [];
  const checks: string[] = [];
  const cancels: string[] = [];
  const adapter: ProviderAdapter = {
    provider: "fal",
    async submit(ctx) {
      submits.push(ctx);
      if (opts?.submit) return await opts.submit(ctx);
      return { providerRef: "fake-ref" };
    },
    async check(ref) {
      checks.push(ref);
      return opts?.check ?? { state: "running" };
    },
    async cancel(ref) {
      cancels.push(ref);
    },
  };
  return { adapter, submits, checks, cancels };
}

export interface FakeModeration {
  moderate: ApiDeps["moderate"];
  calls: { text?: string; imageUrl?: string }[];
  next(result: ModerationDecision): void;
}

export function fakeModeration(): FakeModeration {
  const calls: { text?: string; imageUrl?: string }[] = [];
  let queued: ModerationDecision | null = null;
  return {
    calls,
    next(result) {
      queued = result;
    },
    moderate: (input) => {
      calls.push(input);
      const result = queued ?? { state: "allowed" as const };
      queued = null;
      return Promise.resolve(result);
    },
  };
}

/** A gateway wired to fakes, with TEST_USER signed in and past the age gate. */
export function testDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  const db = new FakeDb();
  db.primaryKeys.webhook_events = "id";
  db.tokens.set("test-token", {
    id: TEST_USER,
    email: "test@example.com",
  });
  db.tables.profiles = [{
    id: TEST_USER,
    birth_date: "1990-01-01",
    strikes: 0,
    prefs: {},
  }];
  db.tables.generations = [];
  db.tables.jobs = [];
  db.tables.models = [];
  db.tables.subscriptions = [];
  db.tables.ledger_entries = [];
  db.rpcHandlers.fn_balances = () => [{
    plan_credits: 10_000,
    pack_credits: 0,
  }];
  const provider = fakeAdapter();
  const moderation = fakeModeration();
  return {
    admin: db as unknown as ApiDeps["admin"],
    stripe: {} as ApiDeps["stripe"],
    moderate: moderation.moderate,
    adapterFor: () => provider.adapter,
    storageFor: () =>
      ({
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        signedUrl: () => Promise.resolve("https://fake.r2/object"),
      }) as unknown as ReturnType<ApiDeps["storageFor"]>,
    appleVerifier: () => ({
      verifyAndDecodeTransaction: () => Promise.resolve({}),
    }),
    fcmAccount: null,
    env: {
      appOrigins: ["https://vansen.app"],
      planPriceIds: {},
      launchCouponId: undefined,
    },
    now: () => db.now(),
    ...over,
  };
}
