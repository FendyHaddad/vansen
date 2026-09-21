# Release Hardening P5 — Durable Dispatch, Idempotency and Atomic Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generation completes correctly while every client is offline, a double-clicked submit charges once, and the limits the product advertises — three pending videos, a daily provider budget, persona slots — hold when four requests arrive at the same instant.

**Architecture:** Submission becomes a reservation: one `fn_reserve_generation` transaction takes the user's advisory lock, checks every cap against live data, charges, and writes the generation, the job and its dispatch work item together — so a crash can never leave a charged generation with no job. `(user_id, idempotency_key, body_hash)` identifies a submission, and a repeat returns the first reservation instead of charging again. A new `job-worker` Edge Function claims jobs with a lease, submits them to providers, polls them, and settles them through P4's `fn_settle_job`. `GET /jobs` becomes a read-only view, so progress no longer depends on a browser tab staying open.

**Tech Stack:** Postgres (plpgsql, advisory locks, `for update skip locked`), Deno, Hono, Supabase Edge Functions, `pg_cron`.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T07**, closing **R06**, **R07** and the limits half of **R09**, and unblocking decisions **D3** and **D6**. It depends on P1 (test seam), P3 (normalized requests) and P4 (settlement). It is a prerequisite for P6 (deleting pending work) and for the mobile plan's **MT-03**.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** P1 adds `0017`, P2 adds `0018`, P4 adds `0019`. This plan adds `0020`. Confirm the deployed inventory first; never renumber an applied migration.
- **New RPCs are service_role-only.** `revoke execute … from public, anon, authenticated; grant execute … to service_role;`
- **Every cap decision happens inside the charge transaction.** A cap checked with a separate `select` before the charge is not a cap; it is a suggestion.
- **Record provider expense even when the customer is refunded.** A refunded job still cost money, and the daily budget must know.
- **Only the current lease may settle a job.** A worker whose lease expired mid-flight must not overwrite the worker that took over.
- **Deploying the new `job-worker` function and scheduling its cron happens in P9**, not here. This plan writes and tests it; it does not deploy it.
- **Redeploying `api` must bundle every `_shared/` file including `providers/`.**
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api job-worker stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`, from P2 Task 1). Angular → `npm test -- --watch=false`.
- **Execution baseline:** run the current focused suite after this plan's prerequisites and record actual counts; predicted totals are not acceptance criteria.

---

## The defects in one paragraph

`POST /generations` charges in one transaction (`fn_charge_and_generate`) and then inserts the job rows in a separate statement whose error is **ignored** (`api/index.ts:1206-1210`), after which `jobRow!.id` is dereferenced three times. A failed job insert therefore produces a charged, `pending` generation with no job — which the stale sweep, whose query joins `jobs`, will never find. There is no idempotency key at all, so a retried request after a timeout charges twice. The video caps are read with plain `select`s *before* the charge (lines 964-990), so four simultaneous submissions all see two pending videos and all pass a three-video cap; the daily budget has the same gap, and it is computed from `price_credits` of non-failed rows, so a refunded job's real provider cost silently leaves the budget. Persona slots (line 1794) have the same shape. And every provider poll happens inside `GET /jobs`: close the tab and an asynchronous fal or Runway job is only settled when the user comes back, or 30 minutes later by the timeout sweep, which refunds it.

---

## File Structure

**New:**
- `supabase/migrations/0020_durable_dispatch.sql` — `submissions`, job lease/attempt columns, `provider_expenses`, `fn_reserve_generation`, `fn_claim_jobs`, `fn_release_job`, `expense reservation records`, cron entries.
- `supabase/tests/dispatch.sql`, `supabase/tests/caps_concurrency.sh` — transactional proofs.
- `supabase/functions/_shared/jobs/dispatch.ts` + `_test.ts` — `dispatchJob`, `pollJob`, `AmbiguousSubmit`.
- `supabase/functions/_shared/jobs/lease.ts` + `_test.ts` — `claimJobs`, `renewLease`, `releaseJob`, backoff.
- `supabase/functions/job-worker/index.ts`, `handler.ts`, `handler_test.ts`, `deno.json`, `_shared` symlink.
- `supabase/functions/api/services/idempotency.ts` + `_test.ts` — `bodyHash`, `readIdempotencyKey`.
- `supabase/functions/api/dispatch_routes_test.ts`.

**Modified:**
- `supabase/functions/api/app.ts` — `POST /generations` becomes reserve-then-enqueue; `GET /jobs` becomes read-only; persona training joins the worker.
- `src/app/core/api/api-service.ts`, `src/app/core/api/dtos.ts`, `src/app/core/generations/generation-store.ts` — send an idempotency key.

---

## Task 1: Idempotency key and body hash

**Files:**
- Create: `supabase/functions/api/services/idempotency.ts`, `idempotency_test.ts`
- Modify: `src/app/core/api/api-service.ts`, `src/app/core/api/dtos.ts`, `src/app/core/generations/generation-store.ts`, `src/app/core/api/api-service.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function readIdempotencyKey(c: Context): string | null;   // header `idempotency-key`, uuid only
  export async function bodyHash(payload: unknown): Promise<string>; // sha-256 hex of canonical JSON
  export function canonicalJson(value: unknown): string;             // stable key order, no undefined
  ```
  Client side: `ApiService.post(path, body, opts?: { idempotencyKey?: string })` sets the header.

- [x] **Step 1: Write the failing Deno test**

Create `supabase/functions/api/services/idempotency_test.ts`:

```ts
import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { bodyHash, canonicalJson } from './idempotency.ts';

Deno.test('key order does not change the canonical form', () => {
  assertEquals(
    canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }),
    canonicalJson({ a: 2, c: { y: 2, z: 1 }, b: 1 }),
  );
});

Deno.test('undefined members are dropped, null members are kept', () => {
  assertEquals(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assertNotEquals(canonicalJson({ a: 1, b: null }), canonicalJson({ a: 1 }));
});

Deno.test('array order IS significant — reference slots are ordered', () => {
  assertNotEquals(canonicalJson({ refs: ['a', 'b'] }), canonicalJson({ refs: ['b', 'a'] }));
});

Deno.test('the same request hashes the same', async () => {
  const a = await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 1 });
  const b = await bodyHash({ batch: 1, prompt: 'a cat', familyId: 'flux' });
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

Deno.test('a different prompt hashes differently', async () => {
  const a = await bodyHash({ familyId: 'flux', prompt: 'a cat' });
  const b = await bodyHash({ familyId: 'flux', prompt: 'a dog' });
  assertNotEquals(a, b);
});

Deno.test('a different batch size hashes differently', async () => {
  assertNotEquals(
    await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 1 }),
    await bodyHash({ familyId: 'flux', prompt: 'a cat', batch: 4 }),
  );
});
```

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/idempotency_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/services/idempotency.ts"`.

- [x] **Step 3: Write `api/services/idempotency.ts`**

```ts
// A submission is identified by (user, idempotency key, body hash).
//
// Without this, a request that timed out on the client was indistinguishable
// from a new one: the retry charged again and ran the model again. The body
// hash is what makes the key safe — reusing a key with a DIFFERENT body is a
// client bug, and answering it with the first result would silently give the
// customer something they did not ask for.
import type { Context } from 'jsr:@hono/hono';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A client-supplied key, or null when it did not send a usable one. */
export function readIdempotencyKey(c: Context): string | null {
  const raw = c.req.header('idempotency-key') ?? '';
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

/** Stable JSON: sorted object keys, arrays left alone, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function bodyHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

- [x] **Step 4: Write the failing Angular test**

Append to `src/app/core/api/api-service.spec.ts`:

```ts
it('sends an idempotency key when one is given', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const api = makeApi('tok');
  await api.post('/generations', { prompt: 'x' }, { idempotencyKey: 'key-1' });
  const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
  expect(headers['Idempotency-Key']).toBe('key-1');
});

it('sends no idempotency header when none is given', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const api = makeApi('tok');
  await api.post('/generations', { prompt: 'x' });
  const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
  expect(headers['Idempotency-Key']).toBeUndefined();
});
```

- [x] **Step 5: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: FAIL — `post` takes two arguments.

- [x] **Step 6: Add the option to `ApiService`**

In `src/app/core/api/api-service.ts`:

```ts
export interface RequestOptions {
  /** Makes a retry safe: the server answers a repeat with the first result
   * rather than charging and generating again. */
  idempotencyKey?: string;
}
```

```ts
  post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }
```

```ts
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-vansen-client': 'web',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    // ... unchanged ...
  }
```

- [x] **Step 7: Make `GenerationStore.create` generate a key**

In `src/app/core/generations/generation-store.ts`:

```ts
  /** Charges on the server, prepends the created items, updates the balance.
   * The key is minted per call, so a network retry of the SAME submission is
   * answered with the first result instead of charging twice. */
  async create(request: CreateGenerationRequest): Promise<GenerationDto[]> {
    const response = await this.api.post<CreateGenerationResponse>('/generations', request, {
      idempotencyKey: crypto.randomUUID(),
    });
    this.itemsSig.update((list) => [...response.items, ...list]);
    this.ledger.setCredits(response.credits);
    void this.persist();
    return response.items;
  }
```

- [x] **Step 8: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all api/services/idempotency_test.ts
```

Expected: vitest `244 passed`; deno `6 passed | 0 failed`. User commits.

---

## Task 2: Atomic reservation, expense accounting and persona capacity

**Files:** Create `supabase/migrations/0020_durable_dispatch.sql`, `supabase/tests/dispatch.sql`, `supabase/tests/caps_concurrency.sh`. Extend P4's `0019` settlement contract through this additive migration; do not edit an applied migration.

**Interfaces:**
- `fn_reserve_generation(p_user uuid,p_key uuid,p_hash text,p_items jsonb,p_quote jsonb,p_payload jsonb) returns jsonb`: server-only inputs, returns persisted `{generationIds,jobIds}`.
- `p_quote` contains `provider`, `unitCredits`, `unitProviderCostUsd`, `catalogVersion`, and `quoteVersion`. Batch total is unit × number of items, calculated once inside SQL. Limits come from server-owned policy rows, never HTTP inputs.
- `fn_reserve_persona(p_user uuid,p_key uuid,p_hash text,p_name text) returns jsonb`: atomically creates a draft within the user's current slot limit.
- `fn_reserve_training(p_user uuid,p_persona uuid,p_key uuid,p_hash text,p_payload jsonb) returns jsonb`: atomically charges the existing persona and creates one `training_jobs` row.
- All RPCs revoke public/anon/authenticated execution and grant service_role only. Enable RLS on all new tables.

- [x] **Step 1: Retain SQL RED cases for replay, rollback and caps**

Use seeded local accounts with known plan/pack balances. Sequential same key/body calls and two concurrent calls both return the SAME generation/job IDs, one submission and one charge. Same key with changed hash raises `idempotency_conflict`. Inject a job INSERT failure with a test-only trigger: no generation, charge, expense or submission survives. Run four video submissions against one remaining slot, competing daily/global/provider budgets, and two persona creations against one remaining slot. Assert exact accepted/rejected counts and no orphan pending rows.

```sql
-- After calling the reservation twice with the same seeded user/key/body:
assert (select count(*) from submissions where user_id = v_user and idempotency_key = v_key) = 1;
assert v_first = v_replay, 'replay must return the original persisted IDs';
assert (select count(*) from jobs where user_id = v_user) = jsonb_array_length(v_first->'jobIds');
assert not exists (
  select 1 from generations g left join jobs j on j.generation_id = g.id
  where g.user_id = v_user and g.status = 'pending' and j.id is null
), 'reservation left an orphan';
```

The assertions live inside DO blocks with variables/fixtures declared in `dispatch.sql`; concurrency script uses separate psql sessions and checks their statuses before querying invariants. Fail the harness if any unexpected error is masked.

- [x] **Step 2: Define durable records and keep lifecycle separate from leases**

```sql
create table public.submissions (
  user_id uuid not null references public.profiles on delete cascade,
  idempotency_key uuid not null,
  body_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
alter table public.jobs add column state text not null default 'ready'
  check (state in ('ready','submitting','submitted','reconciling','done'));
-- lease_token/lease_until already exist from P4/0019.
alter table public.jobs add column next_run_at timestamptz not null default now();
alter table public.jobs add column submit_attempts int not null default 0;
alter table public.jobs add column poll_attempts int not null default 0;
alter table public.jobs add column dispatch_key uuid not null default gen_random_uuid();
alter table public.jobs add column payload jsonb not null default '{}';
alter table public.jobs add column cancel_requested_at timestamptz;
create unique index one_generation_job on public.jobs(generation_id);
create table public.provider_expenses (
  job_id uuid primary key references public.jobs(id),
  user_id uuid not null references public.profiles(id),
  provider text not null check (provider in ('google','openai','fal','runway')),
  reserved_usd numeric(14,6) not null check (reserved_usd >= 0),
  actual_usd numeric(14,6),
  incurred_at timestamptz not null default now()
);
```

Backfill existing jobs from evidence: a non-null real provider_ref is `submitted`; terminal generation is `done`; a pending inline/unknown dispatch is `reconciling`, NEVER presumed safe to resubmit. Check existing duplicate jobs before adding the unique index; unresolved duplicates block the migration.

- [x] **Step 3: Implement the reservation transaction in this exact order**

1. Validate nonempty items, uniform operation/family, integer nonnegative unitCredits, nonnegative finite per-item provider cost, and allowlisted provider. The real adapter exposes `provider`; unknown provider is rejected, never stored as `unknown`.
2. Acquire global budget lock, provider budget lock, then the existing per-user money lock. Use this order in generation/training reservations, including every retry. Re-read the authoritative subscription/limits while locked.
3. Read `submissions` by user/key. Equal hash returns `result` immediately; different hash raises conflict. Keep this check before capacity/credit deductions so a valid replay works even when the account has since exhausted its balance.
4. Count pending work INCLUDING reserved, submitting and reconciling work; enforce max pending videos and daily user/global/provider spend using expenses plus active reservations. Do not remove incurred cost on refund. Reject the ENTIRE batch before charging if any cap fails.
5. Call existing `fn_charge_and_generate` from migration `0014` inside this same SQL transaction. It returns the inserted rows with correct plan/pack attribution. Do not trust client `chargedPlan/chargedPack` and do not replace it with a charge-only function.
6. For each returned generation insert exactly one ready job with immutable payload/quote and one expense reservation containing UNIT cost. Collect IDs. Do not multiply unit cost by batch again per row.
7. Insert the replay record before returning:

```sql
v_result := jsonb_build_object('generationIds', v_generation_ids, 'jobIds', v_job_ids);
insert into public.submissions(user_id,idempotency_key,body_hash,result)
values (p_user,p_key,p_hash,v_result);
return v_result;
```

No exceptions are caught inside this transaction: a job/expense/submission insertion failure rolls back the charge and all rows. P8 adds request_snapshots in this same transaction after its schema exists.

- [x] **Step 4: Implement persona creation and training as real worker work**

Use the SAME user/key replay table and money lock for persona creation. Under lock count live draft/training/ready personas and enforce `PERSONA_SLOTS` from server policy, then create the draft and replay record atomically. Route-side counting is only UI guidance.

Create `training_jobs` with `id,user_id,persona_id,state,provider_ref,dispatch_key,payload,lease_token,lease_until,next_run_at,submit_attempts,poll_attempts,cancel_requested_at,last_error`; unique active job per persona. It uses the same state/lease rules below but does not invent a generation FK for a training job. Add matching expense rows keyed by a unique training job ID (separate `training_provider_expenses` table with `job_id,user_id,provider,reserved_usd,actual_usd,incurred_at`, the same numeric constraints as generation expenses), included in ALL budget queries. `fn_reserve_training` rechecks ownership/status/photos, calls existing `fn_charge_persona` and inserts the job/expense/replay result in one transaction.

Add `fn_settle_training(p_job,p_token,p_outcome,p_lora_url,p_error)`: lock user + persona + training job, require current unexpired token and training state, then atomically mark ready/failed and refund charged buckets once on confirmed failure. Persist provider-hosted `lora_url` as a provider artifact, never a fabricated local `lora_path`. P6 adds its external-artifact deletion record.

- [x] **Step 5: Run SQL and concurrent tests GREEN**

```bash
psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/dispatch.sql
bash supabase/tests/caps_concurrency.sh
```

Add a batch=3 assertion: three expense rows each equal one unit cost; their sum equals quoted total, not total ×3. Add mixed plan/pack charge attribution and zero-cost owner cases. User commits.

---

## Task 3: Lease-fenced dispatch, polling and ambiguity recovery

**Files:** Create `_shared/jobs/lease.ts`, `lease_test.ts`, `dispatch.ts`, `dispatch_test.ts`, `payload.ts`, `payload_test.ts` under `supabase/functions`; append RPCs to `0020`. Consume P4's `_shared/jobs/settlement.ts`, `store.ts` and `notifications.ts`.

**Interfaces:**

```ts
type JobState = 'ready' | 'submitting' | 'submitted' | 'reconciling' | 'done';
interface ClaimedJob {
  id: string; user_id: string; generation_id: string; family_id: string;
  state: JobState; provider_ref: string | null; dispatch_key: string;
  lease_token: string; lease_until: string; payload: StoredPayload;
  submit_attempts: number; poll_attempts: number;
}
interface JobDeps {
  admin: SupabaseClient;
  adapterFor(familyId: string): ProviderAdapter;
  resolvePayload(job: ClaimedJob): Promise<SubmitCtx>;
  finish(job: ClaimedJob, result: CheckResult): Promise<void>;
  reconcile(job: ClaimedJob): Promise<'pending' | { providerRef: string } | 'not_submitted'>;
}
```

`StoredPayload` is defined in Task 4; imports use the existing shared Supabase/provider types. `lease.ts` exports `claimJobs(admin,limit)`, `renewLease(admin,id,token)`, and `releaseJob(admin,id,token,nextState,providerRef,delaySeconds,errorCode)`. Each function checks RPC errors and returns a boolean/typed result, never assumes a zero-row update succeeded. Export `runJob(deps,job):Promise<void>` from dispatch.

- [x] **Step 1: Write state-machine RED tests against real claim results**

Run the same job across two claims: ready submits once; submitted polls without submitting again. A transient polling error, 429 Retry-After, or expired lease must not refund. A submit timeout with no ref becomes reconciling and never blindly submits again. Run two workers, let one lease expire, then finish its stale provider call: stale worker cannot persist ref, release the new lease or settle. Crash after provider acceptance/before DB ref write and verify reconciliation. Training has the same cases.

- [x] **Step 2: Implement atomic claim without modifying lifecycle state**

```sql
create function public.fn_claim_jobs(p_limit int)
returns setof public.jobs language sql security definer set search_path = public as $$
  with picked as (
    select id from jobs
    where state <> 'done' and next_run_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_run_at,id for update skip locked limit least(p_limit,50)
  )
  update jobs j set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
  from picked where j.id = picked.id returning j.*;
$$;
```

Renew/release UPDATEs require `id,lease_token,lease_until > now()`; use `RETURNING id` to prove success. Release clears only the lease and persists the explicit next state/ref/deadline. A lease-expiry sweep clears expired lease ownership; it NEVER sets state to ready. Claim joins generations in the service to obtain family_id; it is not a column in the returned jobs row. Training gets equivalent fixed-table RPCs.

- [x] **Step 3: Persist submit intent before making the remote request**

Implement `runJob` with top-level guard clauses:

```ts
if (job.state === 'done') return;
if (job.state === 'submitted') return pollJob(deps, job);
if (job.state === 'submitting' || job.state === 'reconciling') return reconcileJob(deps, job);
return submitJob(deps, job);
```

Create/export the three functions in the same module. `submitJob` first performs a token/expiry-checked ready→submitting UPDATE with `submit_attempts + 1`; no updated row means no remote call. Resolve fresh owned references immediately before submission. Use `dispatch_key` as a provider idempotency key ONLY where a tested provider contract supports it. Persist a returned provider_ref with the same fencing condition, then release as submitted or call P4 finish for an inline result.

Any network timeout after the request might have reached the provider remains reconciling, including a process crash while state=submitting. `reconcileJob` queries by stable dispatch key/request reference where supported. Only an authoritative “not accepted” result can return to ready. If the provider lacks lookup/idempotency, retain reconciling, back off, alert and require an explicit verified resolution; do not fabricate lookup support or auto-resubmit/refund.

`pollJob` calls adapter.check(provider_ref). Running/retryable results preserve submitted and set next_run_at; done uses shared finish with lease token; confirmed terminal failures use shared settleFailed with failureCode and lease token. Honor `retryAfterSeconds` with a bounded exponential backoff (1–300 seconds plus jitter), track polling separately from submit attempts. A retry count/deadline alone does not prove a paid remote job failed. Manual recovery records a decision and retains incurred expense.

- [x] **Step 4: Replace unsafe stale-refund sweeps and fence settlement**

Replace the old generation/persona timeout cron actions in `0020` with reconciliation scheduling. P4's settlement requires current lease token once a job is leased. Extend its transaction to set job state=done and release the lease only on a winning settlement. A stale `fn_fail_job` caller may enqueue recovery but cannot refund active submitted/reconciling work.

Make cancellation a durable `cancel_requested_at` update under the user/job lock. Worker confirms provider cancellation before terminal refund; ready work can be cancelled before dispatch. Unsupported/unreachable cancellation keeps work pending with truthful status. P6 consumes this request mechanism.

- [x] **Step 5: Verify services, SQL fencing and bundling**

Run `deno test --allow-all _shared/jobs` and local `dispatch.sql`; add retained tests for every state transition above. Fake deps implement `finish`, not an unused `storageFor`. Every shared module imports only other `_shared` modules, never `../../api/services`. User commits.

---

## Task 4: Reserve in the gateway, execute every provider in the worker

**Files:** Modify `api/app.ts`, `_shared/generation-request.ts` and tests; create `job-worker/{index.ts,handler.ts,handler_test.ts,deno.json}`, its `_shared` symlink, `api/dispatch_routes_test.ts`; implement `_shared/jobs/payload.ts`.

- [x] **Step 1: Define and persist immutable worker input**

```ts
export interface StoredPayload {
  familyId: string; op: string; prompt: string;
  settings: Record<string, unknown>; providerModel: string;
  providerSettings: Record<string, unknown>;
  quoteVersion: number; catalogVersion: string; safetyId: string;
  referenceUploadId?: string; parentId?: string; maskUploadId?: string;
  referenceSlots?: { first?: string; last?: string; references?: string[] };
  personaId?: string; styleId?: string; trendId?: string; mode?: VideoMode;
}
```

Store upload/generation/persona IDs, never signed URLs, base64 masks or mutable client prices. Validate all referenced ownership/moderation before reservation AND before dispatch. P8 wraps this payload in its user-facing snapshot schema; this immutable job payload already exists for offline dispatch.

Extend P3 normalization to video, edit/upscale and persona operations explicitly using the existing adapter mappings + verified capability record. Quote and provider payload consume the same normalized selections. Unsupported combinations/version mismatches fail before charging. Do not send image-normalizer fallbacks to video families.

- [x] **Step 2: Implement `resolvePayload` and prove URLs are refreshed**

`resolvePayload(admin,storageFor,job):Promise<SubmitCtx>` reads IDs as the job owner, requires current available/allowed records, signs each with the actual backend/bucket and a provider-suitable TTL, reads mask bytes only when needed, and preserves first/last slot order. Copy immutable op/prompt/settings/model mapping and resolve parentVideoUrl, interactionId and persona loraUrl from owned records. Missing/foreign/deleted records fail before a new submit and use P4's safe failure path.

In `payload_test.ts`, construct a valid owned upload row with P1's `path,bytes,mime,purpose,width,height,moderation`. Sign it once, advance the injected clock beyond that URL's expiry, call resolvePayload again and assert a NEW URL and correct slot/purpose/owner. Delete it and assert no provider call. Cover image reference, mask, two keyframes, parent-video and persona. No empty “re-sign” test bodies.

- [x] **Step 3: Wire gateway, worker and read-only queries**

POST normalizes, moderates, hashes and calls reservation, then returns 202 with persisted IDs promptly. Same-key replay returns the same IDs and never dispatches in the request. Remove inline dispatch and provider polling from `GET /jobs` AND `GET /personas`. The latter returns worker-maintained training state.

Worker `handler.ts` validates a dedicated worker secret before claiming; invalid/missing secret is 401. `index.ts` supplies production deps and bounded per-tick concurrency. It claims generation/training work, runs dispatch, then drains notifications independently of client requests.

```ts
import { finishJob } from './_shared/jobs/store.ts';
import { drainNotifications } from './_shared/jobs/notifications.ts';
// Composition passes this into JobDeps.finish:
const finish = (job: ClaimedJob, result: CheckResult) =>
  finishJob({ admin, storageFor, fetch }, { ...job, attempts: job.poll_attempts }, result);
```

Deno entrypoints import only bundled shared code. Type-check worker separately so an API-relative import cannot hide behind API tests.

- [x] **Step 4: Run route and offline contract tests**

```bash
cd supabase/functions
deno check api/index.ts job-worker/index.ts
deno test --allow-all api/dispatch_routes_test.ts job-worker _shared/jobs
```

Route tests assert 202 without provider submit, persisted replay IDs, changed-body 409, worker authentication, GET calls zero provider APIs, training advances with no client, and correctly accounted failed job insertion. Run Angular idempotency-key tests: retries reuse the key, deliberately edited requests get a new key, double clicks share an in-flight request. User commits.

---

## Task 5: Schedule the worker and gate background-completion promises

**Files:**
- Modify: `supabase/migrations/0020_durable_dispatch.sql` (add the worker cron), `src/app/features/workspace/pending-video-card/pending-video-card.html` and other background-completion copy
- Create: `docs/superpowers/plans/2026-09-20-dispatch-verification-log.md`

- [x] **Step 1: Add the worker cron to the migration**

Append to `0020_durable_dispatch.sql`:

```sql
-- Required prerequisites: pg_cron, pg_net and Supabase Vault. Missing extension
-- installation fails migration setup; never catch and skip the schedule.
select cron.unschedule(jobid) from cron.job where jobname = 'drive_job_worker';
select cron.schedule('drive_job_worker', '* * * * *', $schedule$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='job_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='job_worker_secret')),
    body := '{}'::jsonb
  );
$schedule$);
```

Confirm `pg_net` is available on this project before relying on `net.http_post`:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -t -A -c "select extname from pg_extension where extname in ('pg_net','pg_cron');"
```

Expected: both names. If `pg_net` is absent, add `create extension if not exists pg_net;` to the migration and re-run.

- [x] **Step 2: Write the offline-completion rehearsal log**

Create `docs/superpowers/plans/2026-09-20-dispatch-verification-log.md` with the scenarios that must be demonstrated on the local stack:

| Scenario | Expected |
|---|---|
| Submit a job, then close every client | Generation reaches `done` with media, driven only by the worker |
| Submit, kill the worker mid-flight, restart it | Lease expires, another tick picks the job up, one result |
| Double-click submit (same key) | One charge, one generation, one provider call |
| Retry with the same key after a client timeout | The original generation is returned, no second charge |
| Same key, edited prompt | 409 `idempotency_conflict`, nothing charged |
| Four simultaneous video submissions | Exactly three accepted, the fourth refused with `too_many_jobs` |
| A run that crosses the remaining daily budget | Refused with `daily_cap` and a reset time |
| Two concurrent persona creations at the slot limit | Exactly one accepted |
| A provider that never answers | Kept in reconciliation with backoff and an alert; only confirmed failure/cancellation or an audited recovery decision settles/refunds |
| A reference whose signed URL would have expired | Re-signed at submit time; the provider receives a working URL |

- [x] **Step 3: Remove the current unconditional promise and gate verified copy**

Search the web client for copy that was written around the old constraint:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "keep this page\|stay on this page\|don't close\|do not close\|leave this page" src/app --include=*.html --include=*.ts
```

The existing pending-video-card already promises completion/notification. Replace that unconditional text in this task, with a default-off public capability flag supplied by P9's verified manifest. Add a missing/unreachable-capability test as well as false/true states.

For each hit, separate **D3 background completion** from **D6 completion notifications**. This plan prepares capability-gated copy but does not deploy it: production may show background-completion wording only after P9 confirms the deployed worker and offline-completion rehearsal. A local rehearsal alone cannot change the live promise.

Add a failing copy/capability test with these cases before changing the UI:

| Verified capability state | Permitted wording |
|---|---|
| Worker absent or offline-completion evidence missing | Do not promise that work completes after every client closes |
| Deployed worker and offline completion verified; notification prerequisites incomplete | “You can leave this page and return to check the result.” |
| P4 outbox + P5 offline completion + mobile MT-04 delivery and client receipt verified | Notification wording may be enabled after P9 Task 6 records D6 PASS |

Keep “We'll notify you” unavailable on both platforms until the source spec's D6 prerequisites pass. Prove outbox retry after a send failure and duplicate handling; link actual background/closed-client receipt from MT-04 in the release record. Permission-denied clients must receive truthful recovery guidance. Job lease ownership remains a lifecycle implementation detail, not a redefinition of D6. Run the copy tests GREEN after wiring the release capability state, retaining the existing visual composition.

- [x] **Step 4: Final run**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api job-worker stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f tests/dispatch.sql && ./tests/caps_concurrency.sh
```

Expected: all green. User commits.

---

## Exit criteria for P5

- [x] A generation submitted with every client then closed reaches `done` with retrievable media, driven only by the worker. *(Proven in-process against the real route, worker, dispatcher and finisher with fake transports — `api/offline_completion_test.ts`. The deployed rehearsal needs the function and its cron, which is P9.)*
- [x] The same idempotency key and body charges once and returns the original generation; the same key with a different body returns 409.
- [x] No `pending` generation exists without a job row — asserted by a SQL check after the rehearsal (`supabase/tests/dispatch.sql` block 17, against the local database).
- [x] Four concurrent video submissions produce exactly three pending videos, proven three times by `caps_concurrency.sh`.
- [x] A refunded job's provider cost still counts against the daily budget.
- [x] A submit whose outcome is unknown is reconciled using verified provider lookup, or held for explicit recovery if lookup is unavailable; it is never blindly submitted again.
- [x] A worker whose lease expired cannot settle over the worker that took over.
- [x] `GET /jobs` makes zero provider calls.
- [x] A job deferred past the signed-URL lifetime re-signs its references before submitting.
- [x] D3 copy is gated on deployed, verified background completion; D6 notification copy remains unavailable until P4/P5 and mobile MT-04 delivery/receipt evidence passes in P9 Task 6.

**Known carry-forward:** deleting an account or a generation still leaves stored objects behind — P6. The `job-worker` function is written and tested but **not deployed**, and its Vault configuration is not set; P9 does both.
