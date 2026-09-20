# Release Hardening P4 — Job Settlement and Storage Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generation marked `done` always has media a customer can open, and a generation marked `failed` always refunds exactly once — even when storage rejects the write, the provider is briefly unreachable, a cancel races the result, or the same job is settled twice.

**Architecture:** One `fn_settle_job` RPC performs every terminal transition. It takes the expected current state, writes the generation status, the job row, the refund ledger entries and a notification outbox row together, and returns what it actually did. TypeScript stops making terminal decisions in four different places. Provider checks gain a fourth state — `retryable_failure` — so a 429 or a CDN hiccup no longer looks identical to a model refusing the prompt, and cancellation returns an explicit outcome so a failed cancel transport can never trigger a refund on a job that is still running.

**Tech Stack:** Postgres (plpgsql, advisory locks), Deno, Hono, `jsr:@supabase/supabase-js@2`, Cloudflare R2 via the S3 API.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T06**, closing **R05** and **R08**. It depends on P1 (the `createApp` seam and the fakes) and is a prerequisite for P5 (durable dispatch) and P6 (deletion of pending work).

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** highest on disk is `0016_video.sql` (present on disk; deployed state **unverified**); P1 adds `0017`, P2 adds `0018`. This plan adds `0019`. Confirm the deployed inventory before adding it and never renumber an applied migration.
- **New RPCs are service_role-only:** `revoke execute … from public, anon, authenticated; grant execute … to service_role;`
- **A refund is a money movement.** Never refund on a transport failure, a timeout of a cancel call, or an ambiguous provider answer. Refund only when the job is genuinely terminal.
- **Never delete media a `done` row still points at.** Every cleanup path re-reads the row first.
- **Buffered uploads stay buffered.** `supabase/functions/_shared/storage/types.ts:6-7` records why: a streaming body makes `fetch` send chunked transfer encoding, which R2's S3 `PutObject` rejects. This plan caps the size **before** the buffer, it does not switch to streaming.
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`, set up in P2 Task 1). Angular → `npm test -- --watch=false`.
- **Baseline after P3:** roughly 160 deno tests (exact count recorded in the P3 commit), 242 vitest tests. Each task states the delta it adds.
- **No deploys.**

---

## The defects in one paragraph

`finishJob`'s image branch (`api/index.ts:456-460`) calls `admin.storage.from('media').upload(...)`, **ignores the returned error**, and then unconditionally sets `status: 'done', media_path: path` with no `.eq('status','pending')` guard. A storage outage therefore produces a library full of `done` rows pointing at objects that do not exist, and the customer has been charged. The same shape appears in `/edits/save` and `/library/import`. Meanwhile `GET /jobs`'s catch block (lines 834-838) calls `fn_fail_job` — a **refund** — on any thrown error, including a 429 from fal and a transient DNS failure, so a job that is still running is refunded and abandoned. The cancel route (lines 877-886) logs a failed `adapter.cancel` and then refunds anyway, so a provider that never received the cancellation still bills us while the customer gets their credits back. And `fn_fail_job` writes `update public.generations set status = 'failed'` after an unguarded read, so two concurrent settlements can both pass the `v_status = 'pending'` check.

---

## File Structure

**New:**
- `supabase/migrations/0019_job_settlement.sql` — `notification_outbox`, `fn_settle_job`, hardened `fn_fail_job`.
- `supabase/tests/job_settlement.sql` — SQL proof of single terminal transition under a real race.
- `supabase/functions/api/services/job-settlement.ts` + `_test.ts` — `settleJob`, `SettleOutcome`.
- `supabase/functions/_shared/providers/provider-errors.ts` + `_test.ts` — `classifyProviderError`, `RETRYABLE_STATUSES`.
- `supabase/functions/api/settlement_routes_test.ts` — route-level proof via `createApp`.

**Modified:**
- `supabase/functions/_shared/providers/types.ts` — `CheckResult` gains `retryable_failure`; `cancel` returns `CancelOutcome`.
- `supabase/functions/_shared/providers/fal.ts`, `runway.ts` — classify errors; cancel returns an outcome.
- `supabase/functions/_shared/storage/index.ts` — `MAX_VIDEO_BYTES`, verified content type; the stale "streams" comment.
- `supabase/functions/api/app.ts` — `finishJob`, `storeVideoResult`, `GET /jobs`, the cancel route, `/edits/save`, `/library/import`.

---

## Task 1: Classify provider failures

**Files:**
- Create: `supabase/functions/_shared/providers/provider-errors.ts`, `provider-errors_test.ts`
- Modify: `supabase/functions/_shared/providers/types.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FailureClass = 'terminal' | 'retryable';
  export class ProviderError extends Error {
    constructor(message: string, readonly failureClass: FailureClass, readonly status?: number);
  }
  export function classifyStatus(status: number): FailureClass;
  export function classifyProviderError(e: unknown): FailureClass;
  ```
  `CheckResult` gains `| { state: 'retryable_failure'; error: string; retryAfterSeconds?: number }`.
  `ProviderAdapter.cancel?(ref): Promise<CancelOutcome>` where `CancelOutcome = 'cancelled' | 'too_late' | 'unsupported' | 'unreachable'`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/providers/provider-errors_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { ProviderError, classifyProviderError, classifyStatus } from './provider-errors.ts';

Deno.test('rate limiting and server errors are retryable', () => {
  assertEquals(classifyStatus(429), 'retryable');
  assertEquals(classifyStatus(500), 'retryable');
  assertEquals(classifyStatus(502), 'retryable');
  assertEquals(classifyStatus(503), 'retryable');
  assertEquals(classifyStatus(504), 'retryable');
  assertEquals(classifyStatus(408), 'retryable');
});

Deno.test('a rejected request is terminal — retrying it wastes money and time', () => {
  assertEquals(classifyStatus(400), 'terminal');
  assertEquals(classifyStatus(401), 'terminal');
  assertEquals(classifyStatus(403), 'terminal');
  assertEquals(classifyStatus(404), 'terminal');
  assertEquals(classifyStatus(422), 'terminal');
});

Deno.test('a ProviderError carries its own classification', () => {
  assertEquals(classifyProviderError(new ProviderError('busy', 'retryable', 429)), 'retryable');
  assertEquals(classifyProviderError(new ProviderError('bad prompt', 'terminal', 400)), 'terminal');
});

Deno.test('a network throw is retryable, not a model refusal', () => {
  assertEquals(classifyProviderError(new TypeError('error sending request for url')), 'retryable');
  assertEquals(classifyProviderError(new DOMException('aborted', 'TimeoutError')), 'retryable');
  assertEquals(classifyProviderError(new Error('connection reset by peer')), 'retryable');
});

Deno.test('an unrecognised throw is retryable — refunding on an unknown error is the worse mistake', () => {
  assertEquals(classifyProviderError(new Error('something odd')), 'retryable');
  assertEquals(classifyProviderError('a string'), 'retryable');
  assertEquals(classifyProviderError(null), 'retryable');
});

Deno.test('a status embedded in a legacy adapter message is still read', () => {
  // fal.ts and friends throw `fal submit 429: ...` today.
  assertEquals(classifyProviderError(new Error('fal submit 429: rate limited')), 'retryable');
  assertEquals(classifyProviderError(new Error('openai generate 400: bad request')), 'terminal');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/provider-errors_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/providers/provider-errors.ts"`.

- [ ] **Step 3: Write `_shared/providers/provider-errors.ts`**

```ts
// Which provider failures are worth another attempt, and which are the answer.
//
// The gateway used to refund on ANY throw from a provider check, so a 429 from
// fal and a model refusing a prompt produced the same outcome: a failed
// generation and a refund. That is wrong in both directions — the customer
// loses a job that was about to succeed, and we pay for provider work we then
// give away. When in doubt this classifies as RETRYABLE: a job that retries
// once too often costs a poll, a job refunded too early costs the result.

export type FailureClass = 'terminal' | 'retryable';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function classifyStatus(status: number): FailureClass {
  if (RETRYABLE_STATUSES.has(status)) return 'retryable';
  if (status >= 400 && status < 500) return 'terminal';
  return 'retryable';
}

const NETWORK_HINTS = [
  'error sending request',
  'connection reset',
  'connection refused',
  'connection closed',
  'timed out',
  'timeout',
  'dns error',
  'broken pipe',
  'network',
];

export function classifyProviderError(e: unknown): FailureClass {
  if (e instanceof ProviderError) return e.failureClass;
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'retryable';
  if (!(e instanceof Error)) return 'retryable';

  // Legacy adapter messages embed the status: `fal submit 429: ...`.
  const match = /\b(\d{3})\b/.exec(e.message);
  if (match) return classifyStatus(Number(match[1]));

  const lower = e.message.toLowerCase();
  if (NETWORK_HINTS.some((hint) => lower.includes(hint))) return 'retryable';
  return 'retryable';
}
```

- [ ] **Step 4: Extend the provider contract**

In `_shared/providers/types.ts`, add to `CheckResult`:

```ts
  /** The provider is briefly unavailable. Poll again; do NOT refund. */
  | { state: 'retryable_failure'; error: string; retryAfterSeconds?: number }
```

and replace the `cancel` signature:

```ts
/**
 * What actually happened when we asked the provider to stop.
 * `unreachable` is the important one: it must never produce a refund, because
 * the job is probably still running and will still bill us.
 */
export type CancelOutcome = 'cancelled' | 'too_late' | 'unsupported' | 'unreachable';
```

```ts
  /** Optional. Providers that cannot cancel omit it (Veo, Omni). */
  cancel?(providerRef: string): Promise<CancelOutcome>;
```

- [ ] **Step 5: Run the test and check every adapter still compiles**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/provider-errors_test.ts; deno check api/app.ts
```

Expected: `6 passed | 0 failed`, then `deno check` FAILS on the adapters whose `cancel` returns `Promise<void>`. Task 2 fixes them; do not commit yet.

---

## Task 2: fal and runway report what they know

**Files:**
- Modify: `supabase/functions/_shared/providers/fal.ts`, `supabase/functions/_shared/providers/runway.ts`
- Create: `supabase/functions/_shared/providers/cancel_contract_test.ts`

**Interfaces:**
- Consumes: `ProviderError`, `classifyStatus`, `CancelOutcome` (Task 1).
- Produces: `falAdapter.cancel` and `runwayAdapter.cancel` returning a `CancelOutcome`; both `check` implementations returning `retryable_failure` where they previously threw or reported `failed`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/providers/cancel_contract_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { falAdapter } from './fal.ts';
import { runwayAdapter } from './runway.ts';
import { captureFetch } from './testing/capture.ts';

Deno.test('fal: cancelling a QUEUED request succeeds', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) return new Response(JSON.stringify({ status: 'IN_QUEUE' }), { status: 200 });
    return new Response('', { status: 200 });
  });
  assertEquals(await falAdapter.cancel!('req_1'), 'cancelled');
  cap.restore();
});

Deno.test('fal: a request already IN_PROGRESS reports too_late, never cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) return new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 });
    return new Response('', { status: 200 });
  });
  assertEquals(await falAdapter.cancel!('req_1'), 'too_late');
  cap.restore();
});

Deno.test('fal: an unreachable provider reports unreachable, so no refund follows', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => {
    throw new TypeError('error sending request for url');
  });
  assertEquals(await falAdapter.cancel!('req_1'), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 while cancelling is unreachable, not cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  assertEquals(await falAdapter.cancel!('req_1'), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 on check is retryable, not failed', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  const result = await falAdapter.check('req_1');
  assertEquals(result.state, 'retryable_failure');
  cap.restore();
});

Deno.test('fal: a 400 on check is a real failure', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('bad request', { status: 400 }));
  const result = await falAdapter.check('req_1');
  assertEquals(result.state, 'failed');
  cap.restore();
});

Deno.test('fal: a CDN failure downloading the finished result is retryable', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
    if (call.url.includes('queue.fal.run')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal/out.png' }] }), { status: 200 });
    }
    return new Response('gateway timeout', { status: 504 });
  });
  const result = await falAdapter.check('req_1');
  assertEquals(result.state, 'retryable_failure');
  cap.restore();
});

Deno.test('runway: cancel reports an outcome for every status', async () => {
  Deno.env.set('RUNWAY_API_KEY', 'test-key');
  const ok = captureFetch(() => new Response('', { status: 204 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'cancelled');
  ok.restore();

  const late = captureFetch(() => new Response('already complete', { status: 409 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'too_late');
  late.restore();

  const down = captureFetch(() => new Response('bad gateway', { status: 502 }));
  assertEquals(await runwayAdapter.cancel!('task_1'), 'unreachable');
  down.restore();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/cancel_contract_test.ts
```

Expected: FAIL — `cancel` returns `undefined`, and `check` throws where `retryable_failure` is expected.

- [ ] **Step 3: Update `fal.ts`**

Add the import:

```ts
import { ProviderError, classifyStatus } from './provider-errors.ts';
import type { CancelOutcome } from './types.ts';
```

Replace `check`'s error handling so a non-OK status is classified rather than thrown, and the result download is wrapped:

```ts
  async check(ref: string): Promise<CheckResult> {
    const statusRes = await fetch(`${FAL_BASE}/requests/${ref}/status`, { headers: await auth() })
      .catch(() => null);
    if (!statusRes) return { state: 'retryable_failure', error: 'fal status unreachable' };
    if (!statusRes.ok) {
      const klass = classifyStatus(statusRes.status);
      const message = `fal status ${statusRes.status}`;
      if (klass === 'retryable') return { state: 'retryable_failure', error: message };
      return { state: 'failed', error: message };
    }
    // ... existing status parsing, unchanged ...
    // When the request is COMPLETED, pulling the result and the bytes is a
    // separate network hop: a CDN hiccup there is not a model failure.
    try {
      // ... existing result fetch + fetchBytes ...
    } catch (e) {
      const klass = classifyProviderError(e);
      if (klass === 'retryable') return { state: 'retryable_failure', error: String(e).slice(0, 200) };
      return { state: 'failed', error: String(e).slice(0, 200) };
    }
  },
```

Replace `cancel`:

```ts
  /**
   * fal only cancels a request that is still IN_QUEUE. Ask first: reporting
   * `cancelled` for a request already rendering would refund a customer for
   * work fal still charges us for, and leave the output orphaned.
   */
  async cancel(ref: string): Promise<CancelOutcome> {
    try {
      const statusRes = await fetch(`${FAL_BASE}/requests/${ref}/status`, { headers: await auth() });
      if (!statusRes.ok) return 'unreachable';
      const status = (await statusRes.json())?.status;
      if (status !== 'IN_QUEUE') return 'too_late';
      const res = await fetch(`${FAL_BASE}/requests/${ref}/cancel`, {
        method: 'PUT',
        headers: await auth(),
      });
      if (!res.ok) return 'unreachable';
      return 'cancelled';
    } catch {
      return 'unreachable';
    }
  },
```

- [ ] **Step 4: Update `runway.ts` the same way**

```ts
  /** Runway can cancel a running task; a 409 means it already finished. */
  async cancel(ref: string): Promise<CancelOutcome> {
    try {
      const res = await fetch(`${RUNWAY_BASE}/v1/tasks/${ref}`, {
        method: 'DELETE',
        headers: runwayHeaders(),
      });
      if (res.ok) return 'cancelled';
      if (res.status === 404 || res.status === 409) return 'too_late';
      return 'unreachable';
    } catch {
      return 'unreachable';
    }
  },
```

and classify its `check` failures with `classifyStatus` exactly as fal now does.

- [ ] **Step 5: Run the test**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers
```

Expected: every provider test file passes, including the existing video adapter tests. If a video adapter test asserted `cancel` resolved to `undefined`, update it to assert the outcome. User commits Tasks 1 and 2 together.

---

## Task 3: One settlement transaction

**Files:**
- Create: `supabase/migrations/0019_job_settlement.sql`, `supabase/tests/job_settlement.sql`

**Interfaces:**
- Produces:
  ```sql
  public.notification_outbox (id, user_id, generation_id, event, created_at, sent_at, attempts)
  public.fn_settle_job(p_job uuid, p_outcome text, p_media_path text, p_backend text,
                       p_meta jsonb, p_error text) returns jsonb
  ```
  `p_outcome` is `'done'` or `'failed'`. Returns `{settled: bool, previous: text, refunded: int}`.
  `fn_fail_job` is rewritten as a thin wrapper over `fn_settle_job` so the existing cron keeps working unchanged.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0019_job_settlement.sql`:

```sql
-- 0019: one terminal transition per job.
--
-- Before this migration a generation could be settled from four places — the
-- inline finish in POST /generations, the poller in GET /jobs, the cancel
-- route, and the stale-job cron — each doing its own read-then-write with no
-- lock. fn_fail_job read `status` and then wrote `failed` in two statements, so
-- two concurrent settlements could both see 'pending'. The image finish path
-- did not even check the storage upload result before writing 'done'.
--
-- Everything terminal now happens here: the status flip, the refund, and the
-- notification the customer sees, in one transaction under the same advisory
-- lock fn_charge_and_generate uses.
-- (written 2026-09-20; apply AFTER 0018_billing_fulfillment.sql)

-- Notifications become durable work rather than a fire-and-forget call made
-- while an HTTP response is still open.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  generation_id uuid,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text
);

create index notification_outbox_pending_idx
  on public.notification_outbox (created_at)
  where sent_at is null;

alter table public.notification_outbox enable row level security;

/**
 * Settle one job exactly once.
 *
 * p_outcome 'done'   → generation becomes done with the given media, no refund.
 * p_outcome 'failed' → generation becomes failed and the charge is refunded to
 *                      the buckets that paid, once per generation per bucket.
 *
 * Returns {settled, previous, refunded}. settled=false with previous<>'pending'
 * means someone else got there first, and the caller must clean up whatever it
 * had staged — never overwrite the winner.
 */
create or replace function public.fn_settle_job(
  p_job uuid,
  p_outcome text,
  p_media_path text default null,
  p_backend text default null,
  p_meta jsonb default '{}'::jsonb,
  p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_status text; v_cp int; v_cpack int; v_refunded int := 0;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then
    return jsonb_build_object('settled', false, 'previous', null, 'refunded', 0);
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text));

  -- Read the generation FOR UPDATE so a concurrent settlement waits here
  -- rather than passing the same 'pending' check.
  select g.status, g.charged_plan, g.charged_pack
    into v_status, v_cp, v_cpack
    from public.generations g
    where g.id = v_gen
    for update;

  if v_status is distinct from 'pending' then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if p_outcome = 'done' then
    update public.generations set
      status = 'done',
      media_path = coalesce(p_media_path, media_path),
      storage_backend = coalesce(p_backend, storage_backend),
      duration_s = coalesce((p_meta->>'durationS')::numeric, duration_s),
      width = coalesce((p_meta->>'width')::int, width),
      height = coalesce((p_meta->>'height')::int, height)
    where id = v_gen;
    update public.jobs set progress = 1, updated_at = now() where id = p_job;
    insert into public.notification_outbox (user_id, generation_id, event)
      values (v_user, v_gen, 'generation_done');
    return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', 0);
  end if;

  update public.generations set status = 'failed' where id = v_gen;
  update public.jobs set error = coalesce(p_error, 'failed'), updated_at = now() where id = p_job;

  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:' || v_gen::text || ':plan')
    on conflict do nothing;
    v_refunded := v_refunded + v_cp;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:' || v_gen::text || ':pack')
    on conflict do nothing;
    v_refunded := v_refunded + v_cpack;
  end if;

  insert into public.notification_outbox (user_id, generation_id, event, payload)
    values (v_user, v_gen, 'generation_failed', jsonb_build_object('error', p_error));

  return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', v_refunded);
end $$;

-- Keep the old name working: the stale-job cron in 0004/0016 calls it, and a
-- migration must not require a cron edit to stay correct.
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_settle_job(p_job, 'failed', null, null, '{}'::jsonb, p_error);
end $$;

revoke execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text)
  to service_role;
```

- [ ] **Step 2: Write the SQL race proof**

Create `supabase/tests/job_settlement.sql`:

```sql
-- One terminal transition per generation, under a real race.
-- LOCAL DATABASE ONLY.
begin;

do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_gen uuid; v_job uuid; v_first jsonb; v_second jsonb; v_refunds int;
begin
  insert into auth.users (id, email) values (v_user, 'settle@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;

  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'image', 'flux', 'FLUX', 'generate', 'p', '{}'::jsonb,
          40, 40, 0, 'pending', '')
  returning id into v_gen;

  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  -- 1. A success and a failure both try to settle. Exactly one wins.
  v_first := public.fn_settle_job(v_job, 'done', 'u/g.png', 'supabase', '{}'::jsonb, null);
  v_second := public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'cancelled');
  assert (v_first->>'settled')::boolean, 'first settlement must win';
  assert not (v_second->>'settled')::boolean, 'second settlement must lose';
  assert v_second->>'previous' = 'done', 'the loser must be told what won';
  assert (select status from public.generations where id = v_gen) = 'done';

  -- 2. The loser refunded nothing.
  select count(*) into v_refunds from public.ledger_entries
    where user_id = v_user and type = 'refund';
  assert v_refunds = 0, format('a won-done job must not refund, got %s entries', v_refunds);
end $$;

do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  v_gen uuid; v_job uuid; v_out jsonb; v_total int;
begin
  insert into auth.users (id, email) values (v_user, 'refund@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'video', 'kling', 'Kling', 'generate', 'p', '{}'::jsonb,
          100, 60, 40, 'pending', '')
  returning id into v_gen;
  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  -- 3. A failure refunds both buckets, exactly once, however often it is called.
  v_out := public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'timeout');
  assert (v_out->>'refunded')::int = 100, format('expected 100 refunded, got %s', v_out->>'refunded');
  perform public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'timeout');
  perform public.fn_fail_job(v_job, 'timeout');
  select coalesce(sum(amount_credits), 0) into v_total from public.ledger_entries
    where user_id = v_user and type = 'refund';
  assert v_total = 100, format('refunded more than once: %s', v_total);

  -- 4. Exactly one failure notification was queued.
  assert (select count(*) from public.notification_outbox
          where generation_id = v_gen and event = 'generation_failed') = 1,
    'one failure, one notification';
end $$;

rollback;
```

- [ ] **Step 3: Apply and run**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0019_job_settlement.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/job_settlement.sql
```

Expected: `CREATE TABLE`/`CREATE FUNCTION` lines, then two `DO` lines and `ROLLBACK` with no assertion failure.

- [ ] **Step 4: Prove the race with two real sessions**

Create `supabase/tests/settlement_concurrency.sh`, modelled on `billing_concurrency.sh` from P2: insert one pending generation and job, fire `fn_settle_job(..., 'done', ...)` and `fn_settle_job(..., 'failed', ...)` from two backgrounded `psql` processes, then assert the generation has exactly one terminal status and `ledger_entries` has either zero refund rows (done won) or exactly one pair (failed won) — never both a `done` status and a refund.

```bash
#!/usr/bin/env bash
# A success and a cancel racing on the same job. LOCAL DATABASE ONLY.
set -euo pipefail
DB="${VANSEN_LOCAL_DB:?set VANSEN_LOCAL_DB first}"
U='aaaaaaaa-0000-4000-8000-000000000003'

read -r GEN JOB <<< "$(psql "$DB" -t -A -F' ' -v ON_ERROR_STOP=1 -c "
  insert into auth.users (id, email) values ('$U','race2@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values ('$U','1990-01-01') on conflict do nothing;
  with g as (
    insert into public.generations
      (user_id,kind,family_id,family_name,op,prompt,settings,price_credits,charged_plan,charged_pack,status,media_url)
    values ('$U','image','flux','FLUX','generate','p','{}'::jsonb,40,40,0,'pending','')
    returning id
  ), j as (
    insert into public.jobs (generation_id,user_id,provider) select id,'$U','fal' from g returning id, generation_id
  )
  select j.generation_id, j.id from j;
")"

psql "$DB" -q -c "select public.fn_settle_job('$JOB','done','u/g.png','supabase','{}'::jsonb,null);" >/dev/null &
psql "$DB" -q -c "select public.fn_settle_job('$JOB','failed',null,null,'{}'::jsonb,'cancelled');" >/dev/null &
wait

STATUS=$(psql "$DB" -t -A -c "select status from public.generations where id='$GEN';")
REFUNDS=$(psql "$DB" -t -A -c "select coalesce(sum(amount_credits),0) from public.ledger_entries where user_id='$U' and type='refund';")
NOTES=$(psql "$DB" -t -A -c "select count(*) from public.notification_outbox where generation_id='$GEN';")

psql "$DB" -q -c "
  delete from public.notification_outbox where user_id='$U';
  delete from public.ledger_entries where user_id='$U';
  delete from public.jobs where user_id='$U';
  delete from public.generations where user_id='$U';
  delete from public.profiles where id='$U';
  delete from auth.users where id='$U';
"

test "$NOTES" = "1" || { echo "FAIL: expected 1 notification, got $NOTES"; exit 1; }
if [ "$STATUS" = "done" ]; then
  test "$REFUNDS" = "0" || { echo "FAIL: done generation was also refunded $REFUNDS"; exit 1; }
else
  test "$REFUNDS" = "40" || { echo "FAIL: failed generation refunded $REFUNDS, expected 40"; exit 1; }
fi
echo "OK: single terminal transition ($STATUS, refunded $REFUNDS)"
```

```bash
cd /Users/user/IdeaProjects/vansen && chmod +x supabase/tests/settlement_concurrency.sh && ./supabase/tests/settlement_concurrency.sh
```

Expected: `OK: single terminal transition (...)`. Run it three times — a race proof that only passes once is not a proof. User commits.

---

## Task 4: The settlement service

**Files:**
- Create: `supabase/functions/api/services/job-settlement.ts`, `supabase/functions/api/services/job-settlement_test.ts`

**Interfaces:**
- Consumes: `fn_settle_job` (Task 3); `FakeDb`.
- Produces:
  ```ts
  export interface SettleOutcome { settled: boolean; previous: string | null; refunded: number }
  export function settleDone(admin, jobId, media: {path: string; backend: 'supabase'|'r2'; meta?: Record<string, unknown>}): Promise<SettleOutcome>;
  export function settleFailed(admin, jobId, error: string): Promise<SettleOutcome>;
  ```
  Both **throw** on an RPC error. A settlement whose result is unknown must not be treated as done.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/services/job-settlement_test.ts`:

```ts
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb } from '../testing/fakes.ts';
import { settleDone, settleFailed } from './job-settlement.ts';

function db(result: Record<string, unknown>): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_settle_job = (args, self) => {
    self.tables.settled ??= [];
    self.tables.settled.push({ ...args });
    return result;
  };
  return d;
}

Deno.test('settleDone passes the media path and backend', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 0 });
  const out = await settleDone(d as never, 'job-1', {
    path: 'u/g.mp4',
    backend: 'r2',
    meta: { durationS: 8, width: 1920, height: 1080 },
  });
  assertEquals(out, { settled: true, previous: 'pending', refunded: 0 });
  assertEquals(d.tables.settled[0], {
    p_job: 'job-1',
    p_outcome: 'done',
    p_media_path: 'u/g.mp4',
    p_backend: 'r2',
    p_meta: { durationS: 8, width: 1920, height: 1080 },
    p_error: null,
  });
});

Deno.test('settleFailed reports what was refunded', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 40 });
  assertEquals(await settleFailed(d as never, 'job-1', 'cancelled'), {
    settled: true, previous: 'pending', refunded: 40,
  });
});

Deno.test('losing the race reports the winner, not an error', async () => {
  const d = db({ settled: false, previous: 'done', refunded: 0 });
  const out = await settleFailed(d as never, 'job-1', 'timeout');
  assertEquals(out.settled, false);
  assertEquals(out.previous, 'done');
});

Deno.test('an rpc error throws — an unknown settlement is never assumed done', async () => {
  const d = db({ settled: true, previous: 'pending', refunded: 0 });
  d.failNext('rpc.fn_settle_job', 'connection reset', '08006');
  await assertRejects(
    () => settleDone(d as never, 'job-1', { path: 'u/g.png', backend: 'supabase' }),
    Error,
    'connection reset',
  );
});

Deno.test('a null rpc result throws rather than reporting a phantom settlement', async () => {
  const d = new FakeDb();
  d.rpcHandlers.fn_settle_job = () => null;
  await assertRejects(() => settleFailed(d as never, 'job-1', 'x'));
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/job-settlement_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/services/job-settlement.ts"`.

- [ ] **Step 3: Write `api/services/job-settlement.ts`**

```ts
// The only way a generation becomes terminal.
//
// Four call sites used to do their own read-then-write: the inline finish, the
// poller, the cancel route and the stale sweep. Routing them all through one
// RPC means "exactly one terminal state, exactly one refund, exactly one
// notification" is a property of the database rather than a property of
// whichever code path happened to run first.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface SettleOutcome {
  settled: boolean;
  /** The status the generation already had when we lost the race. */
  previous: string | null;
  refunded: number;
}

async function settle(
  admin: SupabaseClient,
  args: Record<string, unknown>,
): Promise<SettleOutcome> {
  const { data, error } = await admin.rpc('fn_settle_job', args);
  if (error) throw new Error(error.message);
  if (!data) throw new Error('fn_settle_job returned no result');
  return data as SettleOutcome;
}

export function settleDone(
  admin: SupabaseClient,
  jobId: string,
  media: { path: string; backend: 'supabase' | 'r2'; meta?: Record<string, unknown> },
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'done',
    p_media_path: media.path,
    p_backend: media.backend,
    p_meta: media.meta ?? {},
    p_error: null,
  });
}

export function settleFailed(
  admin: SupabaseClient,
  jobId: string,
  error: string,
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'failed',
    p_media_path: null,
    p_backend: null,
    p_meta: {},
    p_error: error.slice(0, 500),
  });
}
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/job-settlement_test.ts
```

Expected: `5 passed | 0 failed`. User commits.

---

## Task 5: Storage writes are verified before anything says "done"

**Files:**
- Modify: `supabase/functions/api/app.ts` (`finishJob`, `/edits/save`, `/library/import`), `supabase/functions/_shared/storage/index.ts`
- Create: `supabase/functions/api/settlement_routes_test.ts`

**Interfaces:**
- Consumes: `settleDone`, `settleFailed` (Task 4); `createApp`/`testDeps`/`FakeStorage`.
- Produces: `finishJob` never writes `done` without a verified upload; `MAX_VIDEO_BYTES` and `MAX_IMAGE_BYTES` exported from `_shared/storage/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/settlement_routes_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.notification_outbox = [];
  db.rpcHandlers.fn_charge_and_generate = (args) =>
    (args.p_items as Record<string, unknown>[]).map((item, i) => ({
      id: `g${i}`, user_id: TEST_USER, kind: item.kind, family_id: item.familyId,
      family_name: item.familyName, op: item.op, prompt: item.prompt, settings: item.settings,
      price_credits: item.priceCredits, charged_plan: item.priceCredits, charged_pack: 0,
      status: 'pending', media_path: null,
    }));
  db.rpcHandlers.fn_settle_job = (args, self) => {
    const gen = (self.tables.generations ?? []).find((g) => g.id === 'g0');
    if (!gen || gen.status !== 'pending') {
      return { settled: false, previous: gen?.status ?? null, refunded: 0 };
    }
    if (args.p_outcome === 'done') {
      gen.status = 'done';
      gen.media_path = args.p_media_path;
      return { settled: true, previous: 'pending', refunded: 0 };
    }
    gen.status = 'failed';
    return { settled: true, previous: 'pending', refunded: Number(gen.charged_plan ?? 0) };
  };
}

function generateBody() {
  return JSON.stringify({
    op: 'generate', familyId: 'flux', prompt: 'a cat', batch: 1,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
  });
}

Deno.test('R05: a failed media upload must NOT produce a done generation', async () => {
  const provider = fakeAdapter({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      }),
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [];
  db.storage.failNext('media.upload', 'storage unavailable');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: generateBody(),
  });

  assertEquals(res.status, 200);
  const item = (await res.json()).items[0];
  assertEquals(item.status === 'done', false, 'a generation with no stored media is not done');
  const stored = db.tables.generations.find((g) => g.id === 'g0');
  assertEquals(stored?.status, 'failed');
});

Deno.test('R05: a failed upload refunds the charge', async () => {
  const provider = fakeAdapter({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      }),
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [];
  db.storage.failNext('media.upload', 'storage unavailable');
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: generateBody(),
  });
  const settle = db.rpcCalls.filter((r) => r.name === 'fn_settle_job');
  assertEquals(settle.length, 1);
  assertEquals(settle[0].args.p_outcome, 'failed');
});

Deno.test('a successful upload stores the object and settles done', async () => {
  const provider = fakeAdapter({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      }),
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [];
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: generateBody(),
  });
  assertEquals(db.tables.generations.find((g) => g.id === 'g0')?.status, 'done');
  assertEquals([...db.storage.objects.keys()].some((k) => k.startsWith('media/')), true);
});

Deno.test('R08: a retryable provider failure does NOT refund', async () => {
  const provider = fakeAdapter({ check: { state: 'retryable_failure', error: 'fal status 429' } });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'image', family_id: 'flux', status: 'pending', charged_plan: 40, charged_pack: 0, settings: {}, price_credits: 40, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, attempts: 0, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/jobs?ids=g0', { headers: AUTH });

  assertEquals(res.status, 200);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('R08: a thrown provider check does NOT refund either', async () => {
  const provider = fakeAdapter();
  provider.adapter.check = () => Promise.reject(new TypeError('error sending request for url'));
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'image', family_id: 'flux', status: 'pending', charged_plan: 40, charged_pack: 0, settings: {}, price_credits: 40, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, attempts: 0, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);
  await app.request('/api/jobs?ids=g0', { headers: AUTH });
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('R08: a TERMINAL provider failure does refund', async () => {
  const provider = fakeAdapter({ check: { state: 'failed', error: 'content filtered' } });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'image', family_id: 'flux', status: 'pending', charged_plan: 40, charged_pack: 0, settings: {}, price_credits: 40, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, attempts: 0, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);
  await app.request('/api/jobs?ids=g0', { headers: AUTH });
  const settle = db.rpcCalls.filter((r) => r.name === 'fn_settle_job');
  assertEquals(settle.length, 1);
  assertEquals(settle[0].args.p_outcome, 'failed');
});

Deno.test('R08: a cancel the provider never received does NOT refund', async () => {
  const provider = fakeAdapter();
  provider.adapter.cancel = () => Promise.resolve('unreachable');
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'video', family_id: 'kling', status: 'pending', charged_plan: 100, charged_pack: 0, settings: {}, price_credits: 100, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'cancel_unconfirmed');
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_settle_job').length, 0);
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('R08: a cancel the provider accepted DOES refund', async () => {
  const provider = fakeAdapter();
  provider.adapter.cancel = () => Promise.resolve('cancelled');
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'video', family_id: 'kling', status: 'pending', charged_plan: 100, charged_pack: 0, settings: {}, price_credits: 100, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200);
  assertEquals((await res.json()).refundedCredits, 100);
});

Deno.test('R08: a job already rendering reports too_late and does NOT refund', async () => {
  const provider = fakeAdapter();
  provider.adapter.cancel = () => Promise.resolve('too_late');
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'video', family_id: 'kling', status: 'pending', charged_plan: 100, charged_pack: 0, settings: {}, price_credits: 100, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, claimed_at: null, created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/jobs/g0/cancel', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'not_cancellable');
  assertEquals(db.tables.generations[0].status, 'pending');
});

Deno.test('losing the settlement race drops the object instead of overwriting the winner', async () => {
  const provider = fakeAdapter({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      }),
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [];
  db.rpcHandlers.fn_settle_job = () => ({ settled: false, previous: 'failed', refunded: 40 });
  const app = createApp(deps);
  await app.request('/api/generations', {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: generateBody(),
  });
  assertEquals([...db.storage.objects.keys()].filter((k) => k.startsWith('media/')), []);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/settlement_routes_test.ts
```

Expected: FAIL on every assertion — the storage error is ignored, retryable failures refund, and the cancel route refunds regardless of outcome.

- [ ] **Step 3: Rewrite `finishJob`**

In `app.ts`:

```ts
  /** Upload finished bytes to private storage, then settle — in that order.
   * Writing `done` before the object exists produced library rows pointing at
   * nothing, on a generation the customer had already paid for. */
  async function finishJob(
    job: { id: string; user_id: string; generation_id: string; attempts?: number },
    result: CheckResult,
  ): Promise<void> {
    if (result.state === 'running') {
      await admin
        .from('jobs')
        .update({
          ...(result.progress != null ? { progress: result.progress } : {}),
          ...(result.queuePosition != null ? { queue_position: result.queuePosition } : {}),
          phase: result.phase ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
      return;
    }
    if (result.state === 'retryable_failure') {
      // The provider is briefly unavailable. The job stays pending and the
      // next poll tries again; refunding here throws away work in flight.
      console.warn('provider_retryable', job.id, result.error);
      await admin
        .from('jobs')
        .update({ phase: 'queued', updated_at: new Date().toISOString() })
        .eq('id', job.id);
      return;
    }
    if (result.state === 'failed') {
      await settleFailed(admin, job.id, result.error);
      return;
    }
    if (isUrlResult(result)) {
      await storeVideoResult(job, result);
      return;
    }

    const path = `${job.user_id}/${job.generation_id}.png`;
    const { error: upErr } = await admin.storage
      .from('media')
      .upload(path, result.bytes, { contentType: result.contentType, upsert: true });
    if (upErr) {
      // No object, no `done`. The refund is the honest outcome: the customer
      // paid for a file we could not keep.
      console.error('media_upload_failed', job.generation_id, upErr.message);
      await settleFailed(admin, job.id, 'store_failed');
      return;
    }
    const outcome = await settleDone(admin, job.id, { path, backend: 'supabase' });
    if (!outcome.settled) {
      // Someone else settled first (a cancel, or the stale sweep). Their
      // decision stands; this object is orphaned and must go.
      await dropLostObject(job.generation_id, path, 'supabase');
    }
  }
```

Update `dropLostObject` to take the backend and use the right adapter:

```ts
  // Zero rows can also mean a previous attempt already committed `done` and only
  // its response was lost; never delete media a done row still points at.
  async function dropLostObject(
    generationId: string,
    path: string,
    backend: StorageBackend,
  ): Promise<void> {
    const { data: row } = await admin
      .from('generations')
      .select('status,media_path')
      .eq('id', generationId)
      .maybeSingle();
    if (row?.status === 'done' && row.media_path === path) return;
    console.warn('[finishJob] generation already settled, dropping object', generationId);
    if (backend === 'supabase') {
      await admin.storage.from('media').remove([path]).catch(() => undefined);
      return;
    }
    await storageFor('r2').delete(path).catch(() => undefined);
  }
```

Add the imports:

```ts
import { settleDone, settleFailed } from './services/job-settlement.ts';
import { classifyProviderError } from './_shared/providers/provider-errors.ts';
```

- [ ] **Step 4: Cap the video download before it is buffered**

In `_shared/storage/index.ts`, add:

```ts
/** A finished clip at the longest supported duration and the highest supported
 * resolution is far under this. Anything larger is a provider bug or a
 * redirect to the wrong thing, and must not be read into memory. */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
```

Fix the stale comment in `_shared/storage/types.ts` — it currently says the adapter "streams" while `put` takes a `Uint8Array`:

```ts
/**
 * Object storage behind one interface. `put` takes the whole body as bytes on
 * purpose: a streaming request body makes fetch use chunked transfer encoding,
 * which R2's S3 PutObject rejects. Callers must therefore cap the size BEFORE
 * they buffer — see MAX_VIDEO_BYTES.
 */
```

In `storeVideoResult`, replace the download block:

```ts
    const res = await fetch(result.url, { headers: result.headers });
    if (!res.ok || !res.body) throw new Error(`video fetch ${res.status}`);

    // Check what the provider says it is sending BEFORE reading it: the body
    // is buffered whole (R2's PutObject rejects chunked encoding), so an
    // unbounded or mistyped response would be an unbounded allocation.
    const declaredType = (res.headers.get('content-type') ?? result.contentType ?? 'video/mp4')
      .split(';')[0]
      .trim();
    if (!VIDEO_CONTENT_TYPES.has(declaredType)) {
      throw new Error(`unexpected video content type ${declaredType}`);
    }
    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${declaredLength} bytes`);
    }
    const bytes = new Uint8Array(await new Response(res.body).arrayBuffer());
    if (bytes.byteLength > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${bytes.byteLength} bytes`);
    }
    if (bytes.byteLength === 0) {
      throw new Error('video download was empty');
    }
    await storageFor('r2').put(path, bytes, declaredType);
```

and replace the settlement tail with the service, so the conditional update, the notification and the refund come from one place:

```ts
  const outcome = await settleDone(admin, job.id, {
    path,
    backend: 'r2',
    meta: { durationS: result.durationS, width: result.width, height: result.height },
  });
  if (!outcome.settled) {
    await dropLostObject(job.generation_id, path, 'r2');
  }
```

The retry-with-attempts block above it stays, but its terminal branch uses the service:

```ts
    if (attempts >= MAX_STORE_ATTEMPTS) {
      await settleFailed(admin, job.id, 'store_failed');
      return;
    }
```

- [ ] **Step 5: Stop `GET /jobs` refunding on a thrown check**

Replace the catch (evidence lines 834-838):

```ts
    try {
      const result = await adapterFor(gen.family_id).check(job.provider_ref);
      await finishJob(
        { id: job.id, user_id: job.user_id, generation_id: job.generation_id, attempts: job.attempts },
        result,
      );
    } catch (e) {
      logError(c, 'provider_check_failed', e);
      // A poll that could not reach the provider says nothing about the job.
      // Refunding here abandoned jobs that were about to succeed; the stale
      // sweep is what eventually settles a job that never finishes.
      if (classifyProviderError(e) === 'retryable') continue;
      await settleFailed(admin, job.id, String(e).slice(0, 500));
    }
```

- [ ] **Step 6: Make the cancel route act on the outcome**

Replace the adapter-cancel block and the settlement that follows it:

```ts
  const adapter = adapterFor(gen.family_id);
  const cancellable = adapter.cancel && job.provider_ref && job.provider_ref !== 'inline';
  const outcome = cancellable ? await adapter.cancel!(job.provider_ref!) : 'unsupported';

  // A refund is only honest when the provider confirmed it stopped. If we
  // could not reach it, the render is probably still running and still being
  // billed to us — telling the customer it is cancelled and returning their
  // credits is the worst of both.
  if (outcome === 'unreachable') {
    return fail(
      c,
      503,
      'cancel_unconfirmed',
      'We could not reach the model to stop it. Nothing was charged back yet — try again in a moment.',
    );
  }
  if (outcome === 'too_late') {
    return fail(c, 409, 'not_cancellable', 'This render already started and cannot be stopped.');
  }

  const settled = await settleFailed(admin, job.id, 'cancelled');
  if (!settled.settled) {
    return fail(c, 409, 'not_pending', 'This job already finished.');
  }
  return c.json({ refundedCredits: settled.refunded, credits: await creditsOf(userId) });
```

`outcome === 'unsupported'` falls through to the settlement, which is correct: a provider with no cancel API (Veo, Omni) is already excluded by `NOT_CANCELLABLE`, and an inline job has nothing running.

- [ ] **Step 7: Check the upload result in `/edits/save` and `/library/import`**

Both routes upload to `media` and then build a generation row. In each, replace the ignored-error upload with:

```ts
  const { error: mediaErr } = await admin.storage
    .from('media')
    .upload(mediaPath, bytes, { contentType, upsert: false });
  if (mediaErr) {
    logError(c, 'media_upload_failed', new Error(mediaErr.message));
    return fail(c, 503, 'store_failed', 'We could not save that image. Nothing was charged — try again.');
  }
```

These rows are `$0`, so there is no refund to make; the correct behaviour is to refuse rather than to create a library entry pointing at nothing.

- [ ] **Step 8: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all api/settlement_routes_test.ts
```

Expected: `10 passed | 0 failed`.

- [ ] **Step 9: Run every suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f tests/job_settlement.sql && ./tests/settlement_concurrency.sh
```

Expected: all green. Record the deno count in the commit message. User commits.

---

## Task 6: Drain the notification outbox

**Files:**
- Modify: `supabase/functions/api/app.ts` (`notifySettled` → outbox drain), `supabase/migrations/0019_job_settlement.sql` (already has the table)
- Create: `supabase/functions/api/services/outbox_test.ts`

**Interfaces:**
- Consumes: `notification_outbox` (Task 3), `sendGenerationPush`.
- Produces: `drainOutbox(limit)` inside `createApp`, called at the end of `GET /jobs` and after settlement in `POST /generations`. A push failure marks `attempts` and leaves the row for the next drain; it never fails the request.

`fn_settle_job` already writes the outbox row, so every terminal transition — including the ones made by the cron — now has a notification queued. Before this, the cron sweep settled jobs with no push at all.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/services/outbox_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from '../app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from '../testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function withOutbox(rows: Record<string, unknown>[]) {
  const sent: { userId: string; event: string }[] = [];
  const provider = fakeAdapter();
  const deps = testDeps({
    adapterFor: () => provider.adapter,
    fcmAccount: { client_email: 'x@y', private_key: 'k', project_id: 'p' } as never,
    sendPush: ((userId: string, _tokens: string[], event: string) => {
      sent.push({ userId, event });
      return Promise.resolve([]);
    }) as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.notification_outbox = rows;
  db.tables.devices = [{ user_id: TEST_USER, token: 'tok-1' }];
  db.tables.generations = [];
  db.tables.jobs = [];
  return { deps, db, sent, app: createApp(deps) };
}

Deno.test('a queued notification is sent and marked', async () => {
  const { db, sent, app } = withOutbox([
    { id: 'n1', user_id: TEST_USER, generation_id: 'g0', event: 'generation_done', sent_at: null, attempts: 0 },
  ]);
  await app.request('/api/jobs?ids=g0', { headers: AUTH });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].event, 'generation_done');
  assertEquals(db.tables.notification_outbox[0].sent_at !== null, true);
});

Deno.test('an already-sent notification is not sent again', async () => {
  const { sent, app } = withOutbox([
    { id: 'n1', user_id: TEST_USER, generation_id: 'g0', event: 'generation_done', sent_at: '2026-09-20T00:00:00Z', attempts: 1 },
  ]);
  await app.request('/api/jobs?ids=g0', { headers: AUTH });
  assertEquals(sent.length, 0);
});

Deno.test('a push failure leaves the row for the next drain', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({
    adapterFor: () => provider.adapter,
    fcmAccount: { client_email: 'x@y', private_key: 'k', project_id: 'p' } as never,
    sendPush: (() => Promise.reject(new Error('fcm down'))) as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.notification_outbox = [
    { id: 'n1', user_id: TEST_USER, generation_id: 'g0', event: 'generation_done', sent_at: null, attempts: 0 },
  ];
  db.tables.devices = [{ user_id: TEST_USER, token: 'tok-1' }];
  db.tables.generations = [];
  db.tables.jobs = [];

  const res = await createApp(deps).request('/api/jobs?ids=g0', { headers: AUTH });

  assertEquals(res.status, 200, 'a push failure never fails the request');
  assertEquals(db.tables.notification_outbox[0].sent_at, null);
  assertEquals(db.tables.notification_outbox[0].attempts, 1);
});

Deno.test('a user with no devices marks the row sent rather than retrying forever', async () => {
  const { db, app } = withOutbox([
    { id: 'n1', user_id: TEST_USER, generation_id: 'g0', event: 'generation_done', sent_at: null, attempts: 0 },
  ]);
  db.tables.devices = [];
  await app.request('/api/jobs?ids=g0', { headers: AUTH });
  assertEquals(db.tables.notification_outbox[0].sent_at !== null, true);
});
```

Add `sendPush` to `ApiDeps` in `app.ts` and to `testDeps` — P1 Task 2 left push as a direct import:

```ts
  sendPush: typeof sendGenerationPush;
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/outbox_test.ts
```

Expected: FAIL — nothing reads `notification_outbox`.

- [ ] **Step 3: Replace `notifySettled` with an outbox drain**

Delete `notifySettled` and its call sites (the settlement RPC now queues every notification) and add inside `createApp`:

```ts
  const OUTBOX_BATCH = 20;
  const OUTBOX_MAX_ATTEMPTS = 5;

  /**
   * Deliver queued notifications. Best-effort by design: a push that cannot be
   * sent must never fail the request that happened to drain the queue, and a
   * settlement made by the cron (where no request exists) still gets delivered
   * by the next poll rather than being lost.
   */
  async function drainOutbox(userId: string): Promise<void> {
    if (!fcmAccount) return;
    const { data: rows } = await admin
      .from('notification_outbox')
      .select('id,user_id,generation_id,event,attempts')
      .eq('user_id', userId)
      .is('sent_at', null)
      .order('created_at', { ascending: true })
      .limit(OUTBOX_BATCH);
    if (!rows || rows.length === 0) return;

    const { data: devices } = await admin
      .from('devices')
      .select('token')
      .eq('user_id', userId);
    const tokens = (devices ?? []).map((d) => d.token as string);

    for (const row of rows) {
      // Nothing to deliver to: mark it done rather than retrying forever.
      if (tokens.length === 0) {
        await admin
          .from('notification_outbox')
          .update({ sent_at: new Date().toISOString() })
          .eq('id', row.id);
        continue;
      }
      try {
        const stale = await deps.sendPush(
          fcmAccount,
          tokens,
          row.event as PushEvent,
          String(row.generation_id ?? ''),
        );
        await admin
          .from('notification_outbox')
          .update({ sent_at: new Date().toISOString(), attempts: Number(row.attempts) + 1 })
          .eq('id', row.id);
        if (stale.length > 0) {
          await admin.from('devices').delete().eq('user_id', userId).in('token', stale);
        }
      } catch (e) {
        const attempts = Number(row.attempts) + 1;
        const message = e instanceof Error ? e.message : String(e);
        console.error('outbox_send_failed', row.id, attempts, message);
        // After enough tries the notification is not the thing worth retrying;
        // the generation itself is already correct in the library.
        const giveUp = attempts >= OUTBOX_MAX_ATTEMPTS;
        await admin
          .from('notification_outbox')
          .update({
            attempts,
            last_error: message.slice(0, 500),
            ...(giveUp ? { sent_at: new Date().toISOString() } : {}),
          })
          .eq('id', row.id);
      }
    }
  }
```

Call it at the end of `GET /jobs` (after the fresh read, before the response) and at the end of `POST /generations`:

```ts
  await drainOutbox(userId);
```

- [ ] **Step 4: Run the test and the whole suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/app.ts && deno test --allow-all _shared api stripe-webhook appstore-webhook
```

Expected: all green, including the four new outbox tests. User commits.

---

## Task 7: End-to-end failure rehearsal

This task writes no new code. It is the evidence the exit criteria depend on, and its results belong in the P9 release runbook.

- [ ] **Step 1: Write the rehearsal log**

Create `docs/superpowers/plans/2026-09-20-settlement-verification-log.md` with a row per scenario and columns for date, method, expected, observed:

| Scenario | How to force it | Expected |
|---|---|---|
| Storage rejects an image write | `FakeStorage.failNext` in the route test, and a real run with the `media` bucket made read-only on the local stack | Generation `failed`, credits refunded, no orphan object |
| Provider returns 429 mid-poll | Point `FAL_API_KEY` at an invalid key that yields 429, or use the capture harness | Generation stays `pending`, no refund, next poll retries |
| Provider unreachable mid-poll | Block the provider host in `/etc/hosts` on the local stack | Generation stays `pending`, no refund |
| Cancel while fal is queued | Submit a long clip, cancel immediately | `cancelled`, refunded once, no output stored later |
| Cancel while fal is rendering | Submit, wait past the queue, cancel | 409 `not_cancellable`, no refund, clip still delivered |
| Cancel while fal is unreachable | Block the host, then cancel | 503 `cancel_unconfirmed`, no refund, job still pending |
| Success racing the stale sweep | Settle a job manually as `failed` while a store is in flight | One terminal state; the orphan object is deleted |
| Oversize video body | Serve a >512 MB body from a local stub | `store_failed` after `MAX_STORE_ATTEMPTS`, refunded once |
| Truncated video body | Serve a body that ends early | Retried up to `MAX_STORE_ATTEMPTS`, then refunded once |
| Wrong content type | Serve `text/html` from the result URL | Refused before buffering; retried, then refunded |
| Duplicate notification delivery | Drain the outbox twice concurrently | One push per generation |

- [ ] **Step 2: Run every row and fill the log**

Any row that cannot be run is recorded as **not run** with its reason, never as passing.

- [ ] **Step 3: Confirm no orphaned media remains after the rehearsal**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -t -A -c "
  select count(*) from public.generations
  where status = 'done' and (media_path is null or media_path = '');
"
```

Expected: `0`. A non-zero result means a `done` row with no media survived the rehearsal and blocks the exit criteria. User commits the log.

---

## Exit criteria for P4

- [ ] A storage write failure produces a `failed` generation and a refund, never a `done` row with no media — proven by route tests and a real read-only-bucket run.
- [ ] `select count(*) from generations where status='done' and media_path is null` is zero after the failure rehearsal.
- [ ] A 429, a network error, a timeout and a CDN download failure all leave the job pending with no refund; only a genuine provider rejection refunds.
- [ ] A cancel the provider did not confirm returns 503 `cancel_unconfirmed` with no refund; a cancel it accepted refunds exactly once; a render already in progress returns 409.
- [ ] Two settlements racing on one job produce one terminal status, one refund at most, and one notification — proven by `settlement_concurrency.sh` run three times.
- [ ] Every terminal transition, including the ones made by the stale-job cron, queues exactly one notification, and a push failure never fails a request.
- [ ] `deno test --allow-all _shared api stripe-webhook appstore-webhook` is green; the SQL settlement tests are green.

**Known carry-forward:** submissions are still not idempotent, jobs are still inserted outside the charge transaction (a crash between the two still orphans a generation the sweep must catch), and progress still depends on a client polling `GET /jobs`. P5 adds the reservation transaction, the idempotency key and the worker. Deletion still leaves stored objects behind; P6 covers it.
