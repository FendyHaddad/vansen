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

import { FakeDb, installRegistryRpcs, TEST_USER } from "../_shared/testing/fakes.ts";
import type { ApiDeps } from "../app.ts";
import type { ModerationDecision } from "../_shared/moderation.ts";
import type {
  CancelOutcome,
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
  /** What the provider reports when asked to stop. Defaults to 'cancelled'. */
  cancel?: CancelOutcome;
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
      return opts?.cancel ?? "cancelled";
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
  // Every writer records its objects now (P6): without the registry RPCs a
  // route would refuse to store anything, which is the intended production
  // behaviour but not a useful default for tests about other things.
  installRegistryRpcs(db);
  // A faithful stand-in for 0020's reservation: one transaction that charges,
  // writes the generation, its job and its expense, and remembers the
  // submission so a replay returns the same ids. The real one is proven by
  // supabase/tests/dispatch.sql; this exists so route tests can exercise the
  // gateway without a database.
  db.rpcHandlers.fn_reserve_generation = (args, self) => {
    self.tables.submissions ??= [];
    const key = String(args.p_key);
    const existing = self.tables.submissions.find(
      (r) => r.user_id === args.p_user && r.idempotency_key === key,
    );
    if (existing && existing.body_hash !== args.p_hash) {
      throw new Error("idempotency_conflict");
    }
    if (existing) return existing.result;

    const quote = args.p_quote as Record<string, unknown>;
    const items = args.p_items as Record<string, unknown>[];
    const generationIds: string[] = [];
    const jobIds: string[] = [];
    self.tables.generations ??= [];
    self.tables.jobs ??= [];
    self.tables.provider_expenses ??= [];
    for (const item of items) {
      const id = `g${self.tables.generations.length}`;
      const jobId = `j${self.tables.jobs.length}`;
      self.tables.generations.push({
        id,
        user_id: args.p_user,
        kind: item.kind,
        family_id: item.familyId,
        family_name: item.familyName,
        op: item.op,
        prompt: item.prompt,
        settings: item.settings,
        price_credits: item.priceCredits,
        charged_plan: item.priceCredits,
        charged_pack: 0,
        status: "pending",
        media_path: null,
        parent_id: item.parentId ?? null,
      });
      self.tables.jobs.push({
        id: jobId,
        user_id: args.p_user,
        generation_id: id,
        provider: quote.provider,
        state: "ready",
        provider_ref: null,
        lease_token: null,
        lease_until: null,
        payload: args.p_payload,
        dispatch_key: `dk-${jobId}`,
        submit_attempts: 0,
        poll_attempts: 0,
        next_run_at: "2026-01-01T00:00:00Z",
        cancel_requested_at: null,
        error: null,
      });
      self.tables.provider_expenses.push({
        job_id: jobId,
        user_id: args.p_user,
        provider: quote.provider,
        reserved_usd: quote.unitProviderCostUsd,
      });
      generationIds.push(id);
      jobIds.push(jobId);
    }
    const result = { generationIds, jobIds };
    self.tables.submissions.push({
      user_id: args.p_user,
      idempotency_key: key,
      body_hash: args.p_hash,
      result,
    });
    return result;
  };
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
      releaseFlags: { backgroundCompletion: false, completionNotifications: false },
      // Unknown by default: a test that cares about the manifest sets these,
      // and one that does not must not accidentally assert a real revision.
      release: { gitRevision: "", workerVersion: "", deployedAt: null },
    },
    now: () => db.now(),
    ...over,
  };
}
