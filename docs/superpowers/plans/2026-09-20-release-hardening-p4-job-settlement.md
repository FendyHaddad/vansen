# Release Hardening P4 — Job Settlement and Storage Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generation marked `done` always has media a customer can open, and a generation marked `failed` always refunds exactly once — even when storage rejects the write, the provider is briefly unreachable, a cancel races the result, or the same job is settled twice.

**Architecture:** One `fn_settle_job` RPC performs every terminal transition. It takes the expected current state, writes the generation status, the job row, the refund ledger entries and a notification outbox row together, and returns what it actually did. TypeScript stops making terminal decisions in four different places. Provider checks gain a fourth state — `retryable_failure` — so a 429 or a CDN hiccup no longer looks identical to a model refusing the prompt, and cancellation returns an explicit outcome so a failed cancel transport can never trigger a refund on a job that is still running.

**Tech Stack:** Postgres (plpgsql, advisory locks), Deno, Hono, `jsr:@supabase/supabase-js@2`, Cloudflare R2 via the S3 API.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T06**, closing **R05** and **R08**. It depends on P1 and P3 (the `createApp` seam and the fakes) and is a prerequisite for P5 (durable dispatch) and P6 (deletion of pending work).

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** highest on disk is `0016_video.sql` (present on disk; deployed state **unverified**); P1 adds `0017`, P2 adds `0018`. This plan adds `0019`. Confirm the deployed inventory before adding it and never renumber an applied migration.
- **New RPCs are service_role-only:** `revoke execute … from public, anon, authenticated; grant execute … to service_role;`
- **A refund is a money movement.** Never refund on a transport failure, a timeout of a cancel call, or an ambiguous provider answer. Refund only when the job is genuinely terminal.
- **Never delete media a `done` row still points at.** Every cleanup path re-reads the row first.
- **Buffered uploads stay buffered.** `supabase/functions/_shared/storage/types.ts:6-7` records why: a streaming body makes `fetch` send chunked transfer encoding, which R2's S3 `PutObject` rejects. This plan caps the size **before** the buffer, it does not switch to streaming.
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`, set up in P2 Task 1). Angular → `npm test -- --watch=false`.
- **Execution baseline:** run the current focused suite after this plan's prerequisites and record actual counts; predicted totals are not acceptance criteria.
- **No deploys.**

---

## The defects in one paragraph

`finishJob`'s image branch (`api/index.ts:456-460`) calls `admin.storage.from('media').upload(...)`, **ignores the returned error**, and then unconditionally sets `status: 'done', media_path: path` with no `.eq('status','pending')` guard. A storage outage therefore produces a library full of `done` rows pointing at objects that do not exist, and the customer has been charged. The same shape appears in `/edits/save` and `/library/import`. Meanwhile `GET /jobs`'s catch block (lines 834-838) calls `fn_fail_job` — a **refund** — on any thrown error, including a 429 from fal and a transient DNS failure, so a job that is still running is refunded and abandoned. The cancel route (lines 877-886) logs a failed `adapter.cancel` and then refunds anyway, so a provider that never received the cancellation still bills us while the customer gets their credits back. And `fn_fail_job` writes `update public.generations set status = 'failed'` after an unguarded read, so two concurrent settlements can both pass the `v_status = 'pending'` check.

---

## File Structure

**New:**
- `supabase/migrations/0019_job_settlement.sql` — `notification_outbox`, `fn_settle_job`, hardened `fn_fail_job`.
- `supabase/tests/job_settlement.sql` — SQL proof of single terminal transition under a real race.
- `supabase/functions/_shared/jobs/settlement.ts` + `_test.ts` — `settleJob`, `SettleOutcome`.
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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/provider-errors_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/providers/provider-errors.ts"`.

- [x] **Step 3: Write `_shared/providers/provider-errors.ts`**

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

- [x] **Step 4: Extend the provider contract**

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

- [x] **Step 5: Run the test and check every adapter still compiles**

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

- [x] **Step 1: Write the failing test**

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
  assertEquals(await falAdapter.cancel!(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'})), 'cancelled');
  cap.restore();
});

Deno.test('fal: a request already IN_PROGRESS reports too_late, never cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) return new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 });
    return new Response('', { status: 200 });
  });
  assertEquals(await falAdapter.cancel!(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'})), 'too_late');
  cap.restore();
});

Deno.test('fal: an unreachable provider reports unreachable, so no refund follows', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => {
    throw new TypeError('error sending request for url');
  });
  assertEquals(await falAdapter.cancel!(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'})), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 while cancelling is unreachable, not cancelled', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  assertEquals(await falAdapter.cancel!(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'})), 'unreachable');
  cap.restore();
});

Deno.test('fal: a 429 on check is retryable, not failed', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('slow down', { status: 429 }));
  const result = await falAdapter.check(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'}));
  assertEquals(result.state, 'retryable_failure');
  cap.restore();
});

Deno.test('fal: a 400 on check is a real failure', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('bad request', { status: 400 }));
  const result = await falAdapter.check(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'}));
  assertEquals(result.state, 'failed');
  cap.restore();
});

Deno.test('fal: a finished image is handed to the bounded shared store', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch((call) => {
    if (call.url.endsWith('/status')) return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
    if (call.url.includes('queue.fal.run')) {
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal/out.png' }] }), { status: 200 });
    }
    return new Response('gateway timeout', { status: 504 });
  });
  const result = await falAdapter.check(JSON.stringify({statusUrl:'https://queue.fal.run/fal-ai/model/requests/req_1/status',responseUrl:'https://queue.fal.run/fal-ai/model/requests/req_1'}));
  assertEquals(result.state, 'done');
  assertEquals('url' in result ? result.url : null, 'https://cdn.fal/out.png');
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

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/cancel_contract_test.ts
```

Expected: FAIL — `cancel` returns `undefined`, and `check` throws where `retryable_failure` is expected.

- [x] **Step 3: Update `fal.ts`**

Add the import:

```ts
import { ProviderError, classifyStatus } from './provider-errors.ts';
import type { CancelOutcome } from './types.ts';
```

Replace `check`'s error handling so a non-OK status is classified rather than thrown, and the result download is wrapped:

```ts
  async check(providerRef: string): Promise<CheckResult> {
    try {
      const ref = JSON.parse(providerRef) as { statusUrl?: string; responseUrl?: string };
      if (!ref.statusUrl?.startsWith(FAL_BASE + '/') || !ref.responseUrl?.startsWith(FAL_BASE + '/'))
        return { state: 'failed', error: 'fal ref missing queue urls' };
      const statusRes = await fetch(ref.statusUrl, { headers: await auth() });
      if (!statusRes.ok) return falHttpFailure(statusRes);
      const status = await statusRes.json();
      if (status.status === 'IN_QUEUE') return { state: 'running', phase: 'queued', queuePosition: status.queue_position };
      if (status.status === 'IN_PROGRESS') return { state: 'running', phase: 'rendering' };
      if (status.status !== 'COMPLETED') return { state: 'failed', error: 'fal_terminal_failure' };
      const resultRes = await fetch(ref.responseUrl, { headers: await auth() });
      if (!resultRes.ok) return falHttpFailure(resultRes);
      const result = await resultRes.json();
      if (result.video?.url) return { state: 'done', url: result.video.url, contentType: 'video/mp4' };
      const url = result.images?.[0]?.url ?? result.image?.url;
      if (!url) return { state: 'failed', error: 'fal result had no image' };
      // P4 shared store downloads/validates all URL results with bounded memory.
      return { state: 'done', url, contentType: 'image/png' };
    } catch (error) {
      if (error instanceof SyntaxError) return { state: 'failed', error: 'invalid_provider_reference' };
      return { state: 'retryable_failure', error: 'fal_unreachable', retryAfterSeconds: 10 };
    }
  },

// Define this helper outside the adapter object:
function falHttpFailure(response: Response): CheckResult {
  const error = 'fal_http_' + response.status;
  if (classifyStatus(response.status) !== 'retryable') return { state: 'failed', error };
  const retryAfter = response.headers.get('retry-after');
  const numeric = Number(retryAfter);
  const seconds = Number.isFinite(numeric) && numeric > 0 ? numeric : 10;
  return { state: 'retryable_failure', error, retryAfterSeconds: Math.min(300, seconds) };
}
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
      const urls = JSON.parse(ref) as { statusUrl: string; responseUrl: string };
      if (!urls.statusUrl?.startsWith(FAL_BASE + '/') || !urls.responseUrl?.startsWith(FAL_BASE + '/')) return 'unsupported';
      const statusRes = await fetch(urls.statusUrl, { headers: await auth() });
      if (!statusRes.ok) return 'unreachable';
      const status = (await statusRes.json())?.status;
      if (status !== 'IN_QUEUE') return 'too_late';
      const res = await fetch(`${urls.responseUrl}/cancel`, {
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

- [x] **Step 4: Update `runway.ts` the same way**

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

- [x] **Step 5: Run the test**

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
                       p_meta jsonb, p_error text, p_expected_state text default 'pending',
                       p_failure_code text default null, p_lease_token uuid default null) returns jsonb
  ```
  `p_outcome` is `'done'` or `'failed'`. Returns `{settled: bool, previous: text, refunded: int}`.
  `fn_fail_job` is rewritten as a thin wrapper over `fn_settle_job` so the existing cron keeps working unchanged.

- [x] **Step 1: Write the migration**

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
alter table public.generations add column failure_code text;
alter table public.generations add column failure_message text;
alter table public.jobs add column lease_token uuid;
alter table public.jobs add column lease_until timestamptz;

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  generation_id uuid,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  dead_letter_at timestamptz
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
  p_error text default null,
  p_expected_state text default 'pending',
  p_failure_code text default null,
  p_lease_token uuid default null
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

  perform 1 from public.jobs where id = p_job for update;

  -- Read the generation FOR UPDATE so a concurrent settlement waits here
  -- rather than passing the same 'pending' check.
  select g.status, g.charged_plan, g.charged_pack
    into v_status, v_cp, v_cpack
    from public.generations g
    where g.id = v_gen
    for update;

  if p_expected_state <> 'pending' then raise exception 'invalid_expected_state'; end if;
  if exists (select 1 from public.jobs where id = p_job and
    (lease_token is not null or p_lease_token is not null) and
    (lease_token is distinct from p_lease_token or lease_until <= now()))
  then return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0); end if;
  if v_status is distinct from p_expected_state then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if p_outcome not in ('done', 'failed') then raise exception 'invalid_outcome'; end if;
  if p_outcome = 'done' and (p_media_path is null or p_backend not in ('supabase','r2'))
  then raise exception 'verified_media_required'; end if;
  if p_outcome = 'done' then
    update public.generations set
      status = 'done', failure_code = null, failure_message = null,
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

  update public.generations set status = 'failed',
    failure_code = case
      when coalesce(p_failure_code,p_error) = 'cancelled' then 'cancelled'
      when p_failure_code in ('moderation','provider_error','timeout','store_failed') then p_failure_code
      else 'generation_failed' end,
    failure_message = case when coalesce(p_failure_code, p_error) = 'cancelled'
      then 'Cancelled · Refunded' else 'Generation failed. Your credits were refunded.' end
    where id = v_gen;
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
    select v_user, v_gen, 'generation_failed', jsonb_build_object('code', coalesce(p_failure_code, 'generation_failed'))
    where coalesce(p_failure_code, p_error, '') <> 'cancelled';

  return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', v_refunded);
end $$;

-- Keep the old name during P4. P5 replaces timeout refunds with reconciliation
-- before durable provider dispatch is enabled.
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_settle_job(p_job, 'failed', null, null, '{}'::jsonb, p_error);
end $$;

revoke execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text, text, text, uuid)
  to service_role;
```

- [x] **Step 2: Write the SQL race proof**

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

- [x] **Step 3: Apply and run**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0019_job_settlement.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/job_settlement.sql
```

Expected: `CREATE TABLE`/`CREATE FUNCTION` lines, then two `DO` lines and `ROLLBACK` with no assertion failure.

- [x] **Step 4: Prove the race with two real sessions**

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
- Create: `supabase/functions/_shared/jobs/settlement.ts`, `supabase/functions/_shared/jobs/settlement_test.ts`

**Interfaces:**
- Consumes: `fn_settle_job` (Task 3); `FakeDb`.
- Produces:
  ```ts
  export interface SettleOutcome { settled: boolean; previous: string | null; refunded: number }
  export function settleDone(admin, jobId, media: {path: string; backend: 'supabase'|'r2'; meta?: Record<string, unknown>}): Promise<SettleOutcome>;
  export function settleFailed(admin, jobId, error: string): Promise<SettleOutcome>;
  ```
  Both **throw** on an RPC error. A settlement whose result is unknown must not be treated as done.

- [x] **Step 1: Write the failing test**

Create `supabase/functions/_shared/jobs/settlement_test.ts`:

```ts
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb } from '../testing/fakes.ts';
import { settleDone, settleFailed } from './settlement.ts';

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
    p_expected_state: 'pending',
    p_lease_token: null,
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

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs/settlement_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/jobs/settlement.ts"`.

- [x] **Step 3: Write `_shared/jobs/settlement.ts`**

```ts
// The only way a generation becomes terminal.
//
// Four call sites used to do their own read-then-write: the inline finish, the
// poller, the cancel route and the stale sweep. Routing them all through one
// RPC means "exactly one terminal state, exactly one refund, exactly one
// notification outbox entry (delivery is at least once)" is a property of the database rather than a property of
// whichever code path happened to run first.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface SettlementGuard { expectedState?: 'pending'; leaseToken?: string; failureCode?: string }

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
  guard: SettlementGuard = {},
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'done',
    p_media_path: media.path,
    p_backend: media.backend,
    p_meta: media.meta ?? {},
    p_error: null,
    p_expected_state: guard.expectedState ?? 'pending',
    p_lease_token: guard.leaseToken ?? null,
  });
}

export function settleFailed(
  admin: SupabaseClient,
  jobId: string,
  error: string,
  guard: SettlementGuard = {},
): Promise<SettleOutcome> {
  return settle(admin, {
    p_job: jobId,
    p_outcome: 'failed',
    p_media_path: null,
    p_backend: null,
    p_meta: {},
    p_error: error.slice(0, 500),
    p_failure_code: guard.failureCode ?? (error === 'cancelled' ? 'cancelled' : 'generation_failed'),
    p_expected_state: guard.expectedState ?? 'pending',
    p_lease_token: guard.leaseToken ?? null,
  });
}
```

- [x] **Step 4: Run the test**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs/settlement_test.ts
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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/settlement_routes_test.ts
```

Expected: FAIL on every assertion — the storage error is ignored, retryable failures refund, and the cancel route refunds regardless of outcome.

- [x] **Step 3: Rewrite `finishJob`**

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
import { settleDone, settleFailed } from './_shared/jobs/settlement.ts';
import { classifyProviderError } from './_shared/providers/provider-errors.ts';
```

- [x] **Step 4: Cap the video download before it is buffered**

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
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let observed = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        observed += value.byteLength;
        if (observed > MAX_VIDEO_BYTES) throw new Error('video exceeds byte budget');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (declaredLength > 0 && observed !== declaredLength) throw new Error('truncated video');
    const bytes = new Uint8Array(observed);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
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

- [x] **Step 5: Stop `GET /jobs` refunding on a thrown check**

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

- [x] **Step 6: Make the cancel route act on the outcome**

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
  if (outcome === 'too_late' || outcome === 'unsupported') {
    return fail(c, 409, 'not_cancellable', 'This render already started and cannot be stopped.');
  }

  const settled = await settleFailed(admin, job.id, 'cancelled');
  if (!settled.settled) {
    return fail(c, 409, 'not_pending', 'This job already finished.');
  }
  return c.json({ refundedCredits: settled.refunded, credits: await creditsOf(userId) });
```

Before settlement, return readable 409 for `unsupported` when dispatch may have started; refund only a provably unsubmitted job or a confirmed provider cancellation. An inline provider request can still be in flight. P5 replaces route-side cancellation with a lease-owned cancellation request.

- [x] **Step 7: Check final persistence in save/import and own shared finalization**

The upload errors in `/edits/save` and `/library/import` are already checked in this checkout. The unchecked final `generations.update({media_path})` is the defect. Retain checked upload handling and replace that final write in both routes with:

```ts
const { data: saved, error: saveError } = await admin.from('generations')
  .update({ media_path: mediaPath, status: 'done' })
  .eq('id', generationId).eq('user_id', userId)
  .select('id').maybeSingle();
if (saveError || !saved) {
  await admin.storage.from('media').remove([mediaPath]);
  return fail(c, 503, 'save_failed', 'Your image could not be saved. Please retry.');
}
```

Keep the new generation pending until this succeeds; on failure remove the staged pending row and check both compensation results. Record failed cleanup for P6's durable object registry. No success event/notification or library DTO may be emitted before persistence succeeds. Inject final UPDATE failure and a zero-row update in route tests for BOTH endpoints, after a successful upload; assert 503, no done row, no push, and attempted object/row cleanup.

Create `supabase/functions/_shared/jobs/store.ts` in THIS task. Move the bounded URL download, image-byte checks, storage write, settlement and losing-object handling out of `api/app.ts` into that module. Export one entry point:

```ts
export interface FinishJob {
  id: string; user_id: string; generation_id: string;
  attempts: number; lease_token?: string;
}
export interface FinishDeps {
  admin: SupabaseClient;
  storageFor: (backend: StorageBackend) => StorageAdapter;
  fetch: typeof fetch;
}
export function finishJob(deps: FinishDeps, job: FinishJob, result: CheckResult): Promise<void>;
```

Import `SupabaseClient`, storage/provider types from the existing shared modules and settlement from `./settlement.ts`. In the shared finalizer, branch on the generation's verified media kind to choose image versus video MIME/byte cap/backend; a URL result is not necessarily a video. P5 imports `finishJob`; do not introduce a second `storeUrlResult` implementation. Persist using a unique per-attempt object key, never overwrite the winner's key. Pass `{leaseToken: job.lease_token}` to settlement. If settlement transport fails, keep the object for reconciliation; unknown outcome is not a lost race. If a known loser is cleaned up, require a successful read proving the winner uses a different key, check deletion errors, then let P6 enqueue cleanup durably.

Add shared-store tests: HTTP error, wrong MIME, zero bytes, observed/declaration mismatch, stream over cap without length, failed storage, failed settlement RPC, stale lease, and a losing attempt cannot delete/overwrite the winner. Apply the same bounded-reader policy to remote images. Byte caps must include peak allocation (chunks plus destination) and be qualified on the actual edge runtime; 512 MiB is a draft ceiling, not proof it fits.

- [x] **Step 8: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all api/settlement_routes_test.ts
```

Expected: `10 passed | 0 failed`.

- [x] **Step 9: Run every suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f tests/job_settlement.sql && ./tests/settlement_concurrency.sh
```

Expected: all green. Record the Deno count in the verification log. User commits.

---

## Task 6: Lease and drain the notification outbox (D6)

**Files:** Create `supabase/functions/_shared/jobs/notifications.ts`, `notifications_test.ts`, `supabase/tests/notification_outbox.sql`; modify `0019_job_settlement.sql`, `_shared/push.ts` and its tests; remove direct `notifySettled` calls from `api/app.ts`.

**Interfaces:** `drainNotifications(deps, limit): Promise<void>`; deps contain `admin`, `account`, and `sendPush: typeof sendGenerationPush`. Keep the actual three-argument push API: `sendPush(account, tokens, event)`. Extend `PushEvent` with stable `notificationId: string`; retain `type` and `generationId`. Include notificationId in `fcmMessage(...).message.data`, and test its serialization so receiving clients can actually deduplicate. P5 schedules the drainer; GET routes do no delivery work.

- [x] **Step 1: Add real concurrent-claim tests before the migration**

Two SQL sessions claim the same unsent row: exactly one lease is returned. After expiry a new lease can claim; the old token cannot mark sent. Failed delivery remains unsent with next-run/backoff; exhausted retries become dead letter, never fake success. User cancellation creates no failure notification. Test an injected push implementation with signature `(_account, _tokens, event)`, asserting `event.notificationId`.

- [x] **Step 2: Add atomic claim/ack RPCs**

```sql
create function public.fn_claim_notifications(p_limit int)
returns setof public.notification_outbox
language sql security definer set search_path = public as $$
  with picked as (
    select id from notification_outbox
    where sent_at is null and dead_letter_at is null and next_run_at <= now()
      and (lease_until is null or lease_until < now())
    order by created_at, id for update skip locked limit least(p_limit, 100)
  )
  update notification_outbox o set lease_token = gen_random_uuid(),
    lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from picked where o.id = picked.id returning o.*;
$$;
create function public.fn_ack_notification(p_id uuid, p_token uuid, p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update notification_outbox set
    sent_at = case when p_error is null then now() else null end,
    last_error = p_error,
    dead_letter_at = case when p_error is not null and attempts >= 5 then now() else null end,
    next_run_at = now() + interval '1 minute' * least(60, power(2, attempts)),
    lease_token = null, lease_until = null
  where id = p_id and lease_token = p_token and lease_until > now() and sent_at is null;
  return found;
end $$;
revoke all on function public.fn_claim_notifications(int) from public, anon, authenticated;
revoke all on function public.fn_ack_notification(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_claim_notifications(int) to service_role;
grant execute on function public.fn_ack_notification(uuid, uuid, text) to service_role;
```

- [x] **Step 3: Implement delivery using the leased rows**

For each claimed row, query that owner's devices and check the query error. Invoke the three-argument API:

```ts
const stale = await deps.sendPush(deps.account, tokens, {
  type: row.event,
  generationId: row.generation_id,
  notificationId: row.id,
});
```

On success delete only returned stale tokens and acknowledge with the current token. No devices is a recorded no-recipient completion. On failure acknowledge with a safe error code, leaving sent_at null. Missing push configuration is an actionable configuration failure, not delivered. In `push.ts`, stop swallowing retryable HTTP/network failures; return invalid/stale tokens as today, but throw for other failed deliveries. Limit each send attempt below lease lifetime; renew or stop before expiry.

External push is **at least once**: a crash after send but before ack can repeat it. Require receiving clients to deduplicate by notification ID; P9/D6 cannot advertise duplicate-free notifications without that client evidence. Database settlement/outbox creation remains exactly once.

- [x] **Step 4: Run focused checks and retain D6 evidence**

Run `deno test --allow-all _shared/jobs/notifications_test.ts _shared/push_test.ts` from `supabase/functions` and `psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/notification_outbox.sql`. Exercise two drainers and crash-after-send in staging during P9. D6 additionally requires mobile MT-04 receipt and deep-link proof. User commits.

---

## Task 7: End-to-end failure rehearsal

This task writes no new code. It is the evidence the exit criteria depend on, and its results belong in the P9 release runbook.

- [x] **Step 1: Write the rehearsal log**

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

- [x] **Step 2: Run every row and fill the log**

Any row that cannot be run is recorded as **not run** with its reason, never as passing.

- [x] **Step 3: Confirm no orphaned media remains after the rehearsal**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -t -A -c "
  select count(*) from public.generations
  where status = 'done' and (media_path is null or media_path = '');
"
```

Expected: `0`. A non-zero result means a `done` row with no media survived the rehearsal and blocks the exit criteria. User commits the log.

---

## Exit criteria for P4

- [ ] A storage write failure produces a `failed` generation and a refund, never a `done` row with no media — proven by route tests and a real read-only-bucket run. *(Route tests done; the real read-only-bucket run is blocked — no staging project.)*
- [x] `select count(*) from generations where status='done' and media_path is null` is zero after the failure rehearsal. *(0 on the local database, 2026-09-21.)*
- [x] A 429, a network error, a timeout and a CDN download failure all leave the job pending with no refund; only a genuine provider rejection refunds.
- [x] A cancel the provider did not confirm returns 503 `cancel_unconfirmed` with no refund; a cancel it accepted refunds exactly once; a render already in progress returns 409.
- [x] Two settlements racing on one job produce one terminal status, one refund at most, and one notification — proven by `settlement_concurrency.sh` run three times. *(Run four times; both branches reached.)*
- [x] Every terminal transition, including the ones made by the stale-job cron, queues exactly one notification, and a push failure never fails a request. *(The cron's `fn_fail_job` now delegates to `fn_settle_job`; no request pushes at all. Delivery itself is not scheduled until P5.)*
- [x] `deno test --allow-all _shared api stripe-webhook appstore-webhook` is green (267 passed); the SQL settlement tests are green.

**Known carry-forward:** submissions are still not idempotent, jobs are still inserted outside the charge transaction (a crash between the two still orphans a generation the sweep must catch), and progress still depends on a client polling `GET /jobs`. P5 adds the reservation transaction, the idempotency key and the worker. Deletion still leaves stored objects behind; P6 covers it.
