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
- **Baseline after P4:** record the exact deno count from the P4 commit; vitest 242.

---

## The defects in one paragraph

`POST /generations` charges in one transaction (`fn_charge_and_generate`) and then inserts the job rows in a separate statement whose error is **ignored** (`api/index.ts:1206-1210`), after which `jobRow!.id` is dereferenced three times. A failed job insert therefore produces a charged, `pending` generation with no job — which the stale sweep, whose query joins `jobs`, will never find. There is no idempotency key at all, so a retried request after a timeout charges twice. The video caps are read with plain `select`s *before* the charge (lines 964-990), so four simultaneous submissions all see two pending videos and all pass a three-video cap; the daily budget has the same gap, and it is computed from `price_credits` of non-failed rows, so a refunded job's real provider cost silently leaves the budget. Persona slots (line 1794) have the same shape. And every provider poll happens inside `GET /jobs`: close the tab and an asynchronous fal or Runway job is only settled when the user comes back, or 30 minutes later by the timeout sweep, which refunds it.

---

## File Structure

**New:**
- `supabase/migrations/0020_durable_dispatch.sql` — `submissions`, job lease/attempt columns, `provider_expenses`, `fn_reserve_generation`, `fn_claim_jobs`, `fn_release_job`, `fn_record_provider_expense`, cron entries.
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

- [ ] **Step 1: Write the failing Deno test**

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

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/idempotency_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/services/idempotency.ts"`.

- [ ] **Step 3: Write `api/services/idempotency.ts`**

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

- [ ] **Step 4: Write the failing Angular test**

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

- [ ] **Step 5: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: FAIL — `post` takes two arguments.

- [ ] **Step 6: Add the option to `ApiService`**

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

- [ ] **Step 7: Make `GenerationStore.create` generate a key**

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

- [ ] **Step 8: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all api/services/idempotency_test.ts
```

Expected: vitest `244 passed`; deno `6 passed | 0 failed`. User commits.

---

## Task 2: The reservation transaction

**Files:**
- Create: `supabase/migrations/0020_durable_dispatch.sql`, `supabase/tests/dispatch.sql`

**Interfaces:**
- Produces:
  ```sql
  public.submissions (user_id, idempotency_key) unique, body_hash, result jsonb
  public.provider_expenses (user_id, generation_id, provider, cost_usd, charged_at)
  public.jobs  += lease_token uuid, lease_expires_at timestamptz, run_after timestamptz,
                  attempts int, state text, payload jsonb
  public.fn_reserve_generation(p_user, p_key, p_body_hash, p_amount, p_type,
                               p_family_id, p_note, p_items jsonb, p_caps jsonb) returns jsonb
  public.fn_claim_jobs(p_worker uuid, p_limit int, p_lease_seconds int) returns setof public.jobs
  public.fn_release_job(p_job uuid, p_lease uuid, p_run_after timestamptz, p_error text) returns boolean
  public.fn_record_provider_expense(p_user uuid, p_generation uuid, p_provider text, p_cost numeric) returns void
  ```

`p_caps` carries the limits the gateway wants enforced **inside** the lock:

```json
{ "maxPendingVideos": 3, "videoDailyCapUsd": 40, "isVideo": true, "providerCostUsd": 1.2 }
```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0020_durable_dispatch.sql`:

```sql
-- 0020: durable dispatch, idempotent submission, transactional caps.
--
-- Before this migration a submission charged in one transaction and inserted
-- its job rows in a separate statement whose error was ignored, so a failure
-- between the two left a charged, pending generation with no job — invisible
-- to the stale sweep, which joins jobs. Caps were plain SELECTs taken before
-- the charge, so four simultaneous requests all passed a three-video limit.
-- And nothing owned a job between polls: closing the browser stopped progress.
--
-- Everything that must be true at once now happens inside one transaction
-- under the same advisory lock fn_charge_and_generate already takes.
-- (written 2026-09-20; apply AFTER 0019_job_settlement.sql)

-- ── Idempotent submissions ────────────────────────────────────────────────
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  idempotency_key uuid not null,
  body_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
alter table public.submissions enable row level security;

-- ── What a job cost us, whatever the customer was charged ─────────────────
-- A refunded job still spent provider money, and the daily budget has to see
-- it; computing the budget from price_credits of non-failed generations let a
-- refunded run quietly leave the budget it had already consumed.
create table public.provider_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  generation_id uuid,
  provider text not null,
  cost_usd numeric(10,4) not null,
  charged_at timestamptz not null default now()
);
create index provider_expenses_user_day_idx
  on public.provider_expenses (user_id, charged_at desc);
alter table public.provider_expenses enable row level security;

-- ── Job leases ────────────────────────────────────────────────────────────
alter table public.jobs
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists attempts int not null default 0,
  add column if not exists state text not null default 'ready'
    check (state in ('ready', 'leased', 'submitted', 'done')),
  add column if not exists payload jsonb;

create index jobs_runnable_idx
  on public.jobs (run_after)
  where state in ('ready', 'submitted') and error is null;

-- ── Reservation ───────────────────────────────────────────────────────────
/**
 * One transaction: replay-check, cap-check, charge, create generations, create
 * their jobs. Returns {replay, items, credits} or raises.
 *
 * p_caps is the limit set the gateway wants enforced HERE rather than in a
 * SELECT it ran a moment ago:
 *   {"isVideo":bool,"maxPendingVideos":int,"videoDailyCapUsd":numeric,
 *    "providerCostUsd":numeric,"provider":text}
 */
create or replace function public.fn_reserve_generation(
  p_user uuid,
  p_key uuid,
  p_body_hash text,
  p_amount int,
  p_type text,
  p_family_id text,
  p_note text,
  p_items jsonb,
  p_caps jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing record;
  v_pending int;
  v_spent numeric;
  v_oldest timestamptz;
  v_gen public.generations;
  v_ids uuid[] := '{}';
  v_rows jsonb := '[]'::jsonb;
  v_item jsonb;
  v_provider text := coalesce(p_caps->>'provider', 'unknown');
  v_cost numeric := coalesce((p_caps->>'providerCostUsd')::numeric, 0);
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  -- 1. Replay. The same key with a DIFFERENT body is a client bug, not a retry.
  if p_key is not null then
    select * into v_existing from public.submissions
      where user_id = p_user and idempotency_key = p_key;
    if found and v_existing.body_hash is distinct from p_body_hash then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    if found then
      return v_existing.result || jsonb_build_object('replay', true);
    end if;
  end if;

  -- 2. Caps, inside the lock, against live rows.
  if coalesce((p_caps->>'isVideo')::boolean, false) then
    select count(*) into v_pending from public.generations
      where user_id = p_user and kind = 'video' and status = 'pending';
    if v_pending >= coalesce((p_caps->>'maxPendingVideos')::int, 3) then
      raise exception 'too_many_jobs' using errcode = 'P0002';
    end if;

    select coalesce(sum(e.cost_usd), 0), min(e.charged_at)
      into v_spent, v_oldest
      from public.provider_expenses e
      where e.user_id = p_user and e.charged_at >= now() - interval '24 hours';
    if v_spent + v_cost > coalesce((p_caps->>'videoDailyCapUsd')::numeric, 40) then
      raise exception 'daily_cap:%', coalesce(v_oldest, now()) + interval '24 hours'
        using errcode = 'P0003';
    end if;
  end if;

  -- 3. Charge + create generations. Same money rules as fn_charge_and_generate,
  --    which this replaces for the generation path.
  perform public.fn_charge_only(p_user, p_amount, p_type, p_family_id, p_note);

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.generations
      (user_id, kind, family_id, family_name, op, prompt, settings,
       price_credits, charged_plan, charged_pack, status, media_url, parent_id, client)
    values (
      p_user,
      v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
      v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
      (v_item->>'priceCredits')::int,
      (v_item->>'chargedPlan')::int, (v_item->>'chargedPack')::int,
      'pending', '', nullif(v_item->>'parentId','')::uuid, nullif(v_item->>'client','')
    ) returning * into v_gen;

    -- 4. The job is created in the SAME transaction as the charge, so a
    --    charged generation with no job is now impossible.
    insert into public.jobs (generation_id, user_id, provider, state, payload)
      values (v_gen.id, p_user, v_provider, 'ready', coalesce(v_item->'payload', '{}'::jsonb));

    -- 5. Record what this will cost us, before the provider is even called.
    --    A later refund does not remove it: the money was spent.
    if v_cost > 0 then
      insert into public.provider_expenses (user_id, generation_id, provider, cost_usd)
        values (p_user, v_gen.id, v_provider, v_cost);
    end if;

    v_ids := v_ids || v_gen.id;
    v_rows := v_rows || to_jsonb(v_gen);
  end loop;

  return jsonb_build_object(
    'replay', false,
    'generationIds', to_jsonb(v_ids),
    'items', v_rows,
    'credits', public.fn_credits_json(p_user)
  );
end $$;

/** The money half of fn_charge_and_generate, split out so the reservation can
 * charge and then create its own rows with job ids attached. */
create or replace function public.fn_charge_only(
  p_user uuid, p_amount int, p_type text, p_family_id text, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean; v_from_plan int; v_from_pack int;
begin
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  select bal.plan_credits, bal.pack_credits into v_plan, v_pack
    from public.fn_balances(p_user) bal;
  if not v_owner and v_plan + v_pack < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  v_from_plan := case when v_owner then p_amount else least(greatest(v_plan, 0), p_amount) end;
  v_from_pack := p_amount - v_from_plan;
  if v_from_plan > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'plan', -v_from_plan, p_family_id, p_note);
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'pack', -v_from_pack, p_family_id, p_note);
  end if;
end $$;

-- ── Leases ────────────────────────────────────────────────────────────────
/** Claim up to p_limit runnable jobs for this worker. `skip locked` means two
 * workers never fight over the same row, and the lease means a worker that
 * dies hands its jobs back automatically when the lease expires. */
create or replace function public.fn_claim_jobs(
  p_worker uuid, p_limit int default 5, p_lease_seconds int default 120
) returns setof public.jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.jobs j set
    state = 'leased',
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempts = j.attempts + 1,
    updated_at = now()
  where j.id in (
    select j2.id from public.jobs j2
    join public.generations g on g.id = j2.generation_id
    where g.status = 'pending'
      and j2.error is null
      and j2.run_after <= now()
      and (j2.state in ('ready', 'submitted') or j2.lease_expires_at < now())
    order by j2.run_after
    limit p_limit
    for update of j2 skip locked
  )
  returning j.*;
end $$;

/** Hand a job back with a delay, or record a terminal error. Only the holder
 * of the current lease may do this — a worker whose lease expired mid-flight
 * must not stomp the worker that took over. */
create or replace function public.fn_release_job(
  p_job uuid, p_lease uuid, p_run_after timestamptz, p_state text default 'ready',
  p_provider_ref text default null, p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_hit int;
begin
  update public.jobs set
    state = p_state,
    run_after = p_run_after,
    lease_token = null,
    lease_expires_at = null,
    provider_ref = coalesce(p_provider_ref, provider_ref),
    last_error = p_error,
    updated_at = now()
  where id = p_job and lease_token = p_lease;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

alter table public.jobs add column if not exists last_error text;

create or replace function public.fn_record_provider_expense(
  p_user uuid, p_generation uuid, p_provider text, p_cost numeric
) returns void language sql security definer set search_path = public as $$
  insert into public.provider_expenses (user_id, generation_id, provider, cost_usd)
  values (p_user, p_generation, p_provider, p_cost);
$$;

-- ── Recovery sweep, distinct from a timeout refund ────────────────────────
-- Expiring a lease returns a job to the queue. Only a job that has been
-- pending far longer than any provider takes is settled as failed.
select cron.unschedule(jobid) from cron.job where jobname = 'release_expired_leases';
select cron.schedule('release_expired_leases', '* * * * *', $$
  update public.jobs set state = 'ready', lease_token = null, lease_expires_at = null
    where state = 'leased' and lease_expires_at < now();
$$);

revoke execute on function public.fn_reserve_generation(uuid, uuid, text, int, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fn_reserve_generation(uuid, uuid, text, int, text, text, text, jsonb, jsonb) to service_role;
revoke execute on function public.fn_charge_only(uuid, int, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_charge_only(uuid, int, text, text, text) to service_role;
revoke execute on function public.fn_claim_jobs(uuid, int, int) from public, anon, authenticated;
grant execute on function public.fn_claim_jobs(uuid, int, int) to service_role;
revoke execute on function public.fn_release_job(uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_release_job(uuid, uuid, timestamptz, text, text, text) to service_role;
revoke execute on function public.fn_record_provider_expense(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.fn_record_provider_expense(uuid, uuid, text, numeric) to service_role;
```

**Note on `p_items`:** the reservation now expects `chargedPlan`/`chargedPack` per item, which `fn_charge_and_generate` used to compute from the remaining plan credits. The gateway computes the same split in Task 4 and passes it in, so the split stays identical and testable.

- [ ] **Step 2: Write the SQL proof**

Create `supabase/tests/dispatch.sql` with these blocks, each with its own synthetic user:

```sql
begin;

-- 1. A repeated key with the SAME body returns the first result and charges once.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  v_key uuid := '11111111-1111-4111-8111-aaaaaaaaaaaa';
  v_first jsonb; v_second jsonb; v_spend int;
begin
  insert into auth.users (id, email) values (v_user, 'idem@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 1500, 'seed');

  v_first := public.fn_reserve_generation(v_user, v_key, 'hash-1', 40, 'generate', 'flux', 'note',
    jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
      'op','generate','prompt','a cat','settings','{}'::jsonb,'priceCredits',40,
      'chargedPlan',40,'chargedPack',0)),
    jsonb_build_object('provider','fal','providerCostUsd',0.03));
  assert not (v_first->>'replay')::boolean;

  v_second := public.fn_reserve_generation(v_user, v_key, 'hash-1', 40, 'generate', 'flux', 'note',
    jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
      'op','generate','prompt','a cat','settings','{}'::jsonb,'priceCredits',40,
      'chargedPlan',40,'chargedPack',0)),
    jsonb_build_object('provider','fal','providerCostUsd',0.03));
  assert (v_second->>'replay')::boolean, 'a repeat must be a replay';
  assert v_second->'generationIds' = v_first->'generationIds', 'a replay returns the same rows';

  select count(*) into v_spend from public.ledger_entries
    where user_id = v_user and type = 'generate';
  assert v_spend = 1, format('charged %s times, expected 1', v_spend);
  assert (select count(*) from public.generations where user_id = v_user) = 1;
end $$;

-- 2. The same key with a DIFFERENT body is a conflict, not a silent replay.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_key uuid := '22222222-2222-4222-8222-aaaaaaaaaaaa';
  v_caught boolean := false;
begin
  insert into auth.users (id, email) values (v_user, 'conflict@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 1500, 'seed');
  perform public.fn_reserve_generation(v_user, v_key, 'hash-a', 40, 'generate', 'flux', 'n',
    jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
      'op','generate','prompt','a','settings','{}'::jsonb,'priceCredits',40,'chargedPlan',40,'chargedPack',0)),
    '{}'::jsonb);
  begin
    perform public.fn_reserve_generation(v_user, v_key, 'hash-b', 40, 'generate', 'flux', 'n',
      jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
        'op','generate','prompt','b','settings','{}'::jsonb,'priceCredits',40,'chargedPlan',40,'chargedPack',0)),
      '{}'::jsonb);
  exception when sqlstate 'P0001' then v_caught := true;
  end;
  assert v_caught, 'reusing a key with a different body must conflict';
end $$;

-- 3. Every charged generation has a job. No orphans, ever.
do $$
declare v_orphans int;
begin
  select count(*) into v_orphans from public.generations g
    where g.status = 'pending'
      and not exists (select 1 from public.jobs j where j.generation_id = g.id);
  assert v_orphans = 0, format('%s pending generations have no job', v_orphans);
end $$;

-- 4. The video cap is enforced inside the lock.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000003';
  v_caught boolean := false; i int;
begin
  insert into auth.users (id, email) values (v_user, 'cap@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 10000, 'seed');
  for i in 1..3 loop
    perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'h' || i, 100, 'generate', 'kling', 'n',
      jsonb_build_array(jsonb_build_object('kind','video','familyId','kling','familyName','Kling',
        'op','generate','prompt','v','settings','{}'::jsonb,'priceCredits',100,'chargedPlan',100,'chargedPack',0)),
      jsonb_build_object('isVideo',true,'maxPendingVideos',3,'videoDailyCapUsd',40,
        'provider','fal','providerCostUsd',1.0));
  end loop;
  begin
    perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'h4', 100, 'generate', 'kling', 'n',
      jsonb_build_array(jsonb_build_object('kind','video','familyId','kling','familyName','Kling',
        'op','generate','prompt','v','settings','{}'::jsonb,'priceCredits',100,'chargedPlan',100,'chargedPack',0)),
      jsonb_build_object('isVideo',true,'maxPendingVideos',3,'videoDailyCapUsd',40,
        'provider','fal','providerCostUsd',1.0));
  exception when sqlstate 'P0002' then v_caught := true;
  end;
  assert v_caught, 'the fourth pending video must be refused';
end $$;

-- 5. A refunded job still counts against the daily budget.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000004';
  v_gen uuid; v_job uuid; v_spent numeric; v_caught boolean := false;
begin
  insert into auth.users (id, email) values (v_user, 'budget@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 100000, 'seed');
  perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'b1', 100, 'generate', 'kling', 'n',
    jsonb_build_array(jsonb_build_object('kind','video','familyId','kling','familyName','Kling',
      'op','generate','prompt','v','settings','{}'::jsonb,'priceCredits',100,'chargedPlan',100,'chargedPack',0)),
    jsonb_build_object('isVideo',true,'maxPendingVideos',3,'videoDailyCapUsd',40,
      'provider','fal','providerCostUsd',39.5));
  select g.id, j.id into v_gen, v_job from public.generations g
    join public.jobs j on j.generation_id = g.id where g.user_id = v_user limit 1;
  perform public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'timeout');

  select coalesce(sum(cost_usd),0) into v_spent from public.provider_expenses where user_id = v_user;
  assert v_spent = 39.5, format('a refund must not erase the expense, got %s', v_spent);

  begin
    perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'b2', 100, 'generate', 'kling', 'n',
      jsonb_build_array(jsonb_build_object('kind','video','familyId','kling','familyName','Kling',
        'op','generate','prompt','v','settings','{}'::jsonb,'priceCredits',100,'chargedPlan',100,'chargedPack',0)),
      jsonb_build_object('isVideo',true,'maxPendingVideos',3,'videoDailyCapUsd',40,
        'provider','fal','providerCostUsd',1.0));
  exception when sqlstate 'P0003' then v_caught := true;
  end;
  assert v_caught, 'the spent budget must still block the next run';
end $$;

-- 6. Two workers never claim the same job.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000005';
  v_a int; v_b int;
begin
  insert into auth.users (id, email) values (v_user, 'claim@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 10000, 'seed');
  perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'c1', 40, 'generate', 'flux', 'n',
    jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
      'op','generate','prompt','a','settings','{}'::jsonb,'priceCredits',40,'chargedPlan',40,'chargedPack',0)),
    jsonb_build_object('provider','fal','providerCostUsd',0.03));
  select count(*) into v_a from public.fn_claim_jobs(gen_random_uuid(), 5, 120);
  select count(*) into v_b from public.fn_claim_jobs(gen_random_uuid(), 5, 120);
  assert v_a = 1, format('first worker should claim 1, got %s', v_a);
  assert v_b = 0, format('second worker should claim 0, got %s', v_b);
end $$;

-- 7. A stale lease cannot settle over the worker that took over.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000006';
  v_job uuid; v_old uuid; v_new uuid; v_ok boolean;
begin
  insert into auth.users (id, email) values (v_user, 'lease@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 10000, 'seed');
  perform public.fn_reserve_generation(v_user, gen_random_uuid(), 'l1', 40, 'generate', 'flux', 'n',
    jsonb_build_array(jsonb_build_object('kind','image','familyId','flux','familyName','FLUX',
      'op','generate','prompt','a','settings','{}'::jsonb,'priceCredits',40,'chargedPlan',40,'chargedPack',0)),
    jsonb_build_object('provider','fal','providerCostUsd',0.03));
  select id, lease_token into v_job, v_old from public.fn_claim_jobs(gen_random_uuid(), 1, 120);
  -- Expire it and let a second worker take over.
  update public.jobs set lease_expires_at = now() - interval '1 minute' where id = v_job;
  select lease_token into v_new from public.fn_claim_jobs(gen_random_uuid(), 1, 120);
  assert v_new is distinct from v_old, 'the takeover must get a new lease';
  v_ok := public.fn_release_job(v_job, v_old, now(), 'ready', 'stale-ref', null);
  assert not v_ok, 'the stale lease must not be able to write';
end $$;

rollback;
```

- [ ] **Step 3: Apply and run**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0020_durable_dispatch.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/dispatch.sql
```

Expected: seven `DO` lines and `ROLLBACK`, no assertion failure.

- [ ] **Step 4: Race the caps with real concurrent sessions**

Create `supabase/tests/caps_concurrency.sh`: seed a user with credits, fire **four** simultaneous `fn_reserve_generation` calls for videos with `maxPendingVideos: 3`, then assert exactly three pending video generations exist. Model it on `billing_concurrency.sh`.

```bash
cd /Users/user/IdeaProjects/vansen && chmod +x supabase/tests/caps_concurrency.sh && ./supabase/tests/caps_concurrency.sh && ./supabase/tests/caps_concurrency.sh && ./supabase/tests/caps_concurrency.sh
```

Expected: `OK: 3 of 4 concurrent videos accepted` three times in a row. User commits.

---

## Task 3: Lease and dispatch services

**Files:**
- Create: `supabase/functions/_shared/jobs/lease.ts` + `_test.ts`, `supabase/functions/_shared/jobs/dispatch.ts` + `_test.ts`

**Interfaces:**
- Consumes: `fn_claim_jobs`, `fn_release_job` (Task 2); `settleDone`/`settleFailed` (P4); `classifyProviderError` (P4); `FakeDb`.
- Produces:
  ```ts
  // lease.ts
  export interface LeasedJob { id: string; userId: string; generationId: string; provider: string;
    providerRef: string | null; state: string; attempts: number; leaseToken: string; payload: Record<string, unknown> }
  export function claimJobs(admin, workerId, limit, leaseSeconds): Promise<LeasedJob[]>;
  export function releaseJob(admin, job, opts: { state: string; delaySeconds: number; providerRef?: string; error?: string }): Promise<boolean>;
  export function backoffSeconds(attempts: number): number;

  // dispatch.ts
  export const MAX_JOB_ATTEMPTS = 8;
  export function runJob(deps: JobDeps, job: LeasedJob): Promise<'submitted' | 'running' | 'settled' | 'deferred'>;
  ```

- [ ] **Step 1: Write the failing lease test**

Create `supabase/functions/_shared/jobs/lease_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from '../testing/fakes.ts';
import { backoffSeconds, claimJobs, releaseJob } from './lease.ts';

Deno.test('backoff grows and then stops growing', () => {
  assertEquals(backoffSeconds(1), 5);
  assertEquals(backoffSeconds(2), 10);
  assertEquals(backoffSeconds(3), 20);
  assertEquals(backoffSeconds(4), 40);
  assertEquals(backoffSeconds(10), 300);
  assertEquals(backoffSeconds(100), 300);
});

Deno.test('claimJobs maps the rpc rows onto LeasedJob', async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_claim_jobs = () => [
    {
      id: 'j1', user_id: TEST_USER, generation_id: 'g1', provider: 'fal',
      provider_ref: null, state: 'leased', attempts: 1,
      lease_token: 'lease-1', payload: { familyId: 'flux' },
    },
  ];
  const jobs = await claimJobs(db as never, 'worker-1', 5, 120);
  assertEquals(jobs, [{
    id: 'j1', userId: TEST_USER, generationId: 'g1', provider: 'fal',
    providerRef: null, state: 'leased', attempts: 1,
    leaseToken: 'lease-1', payload: { familyId: 'flux' },
  }]);
});

Deno.test('claimJobs returns nothing on an rpc error rather than throwing the worker over', async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_claim_jobs = () => [];
  db.failNext('rpc.fn_claim_jobs', 'connection reset', '08006');
  assertEquals(await claimJobs(db as never, 'worker-1', 5, 120), []);
});

Deno.test('releaseJob reports whether the lease was still ours', async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_release_job = (args) => args.p_lease === 'lease-1';
  const job = {
    id: 'j1', userId: TEST_USER, generationId: 'g1', provider: 'fal',
    providerRef: null, state: 'leased', attempts: 1, leaseToken: 'lease-1', payload: {},
  };
  assertEquals(await releaseJob(db as never, job, { state: 'submitted', delaySeconds: 5 }), true);
  assertEquals(
    await releaseJob(db as never, { ...job, leaseToken: 'stale' }, { state: 'ready', delaySeconds: 5 }),
    false,
  );
});
```

- [ ] **Step 2: Run to verify it fails, then write `lease.ts`**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs/lease_test.ts
```

Expected: FAIL — module not found. Then create `supabase/functions/_shared/jobs/lease.ts`:

```ts
// Job ownership between polls.
//
// A lease is a short exclusive claim: while it is held nobody else touches the
// job, and if the worker dies the lease simply expires and the job returns to
// the queue. The alternative — a boolean "claimed" flag — strands every job a
// crashed process was holding, which is exactly what claimed_at did for video
// saves before this.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface LeasedJob {
  id: string;
  userId: string;
  generationId: string;
  provider: string;
  providerRef: string | null;
  state: string;
  attempts: number;
  leaseToken: string;
  payload: Record<string, unknown>;
}

const BASE_BACKOFF_S = 5;
const MAX_BACKOFF_S = 300;

/** Exponential with a ceiling: a provider having a bad minute should not be
 * hammered, and a job should never wait longer than five minutes to retry. */
export function backoffSeconds(attempts: number): number {
  const seconds = BASE_BACKOFF_S * 2 ** Math.max(0, attempts - 1);
  return Math.min(seconds, MAX_BACKOFF_S);
}

export async function claimJobs(
  admin: SupabaseClient,
  workerId: string,
  limit = 5,
  leaseSeconds = 120,
): Promise<LeasedJob[]> {
  const { data, error } = await admin.rpc('fn_claim_jobs', {
    p_worker: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    // A worker tick that cannot reach the database does nothing and tries
    // again next tick. Throwing here would take the whole function down.
    console.error('claim_failed', error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    generationId: String(row.generation_id),
    provider: String(row.provider),
    providerRef: row.provider_ref == null ? null : String(row.provider_ref),
    state: String(row.state),
    attempts: Number(row.attempts),
    leaseToken: String(row.lease_token),
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
}

export async function releaseJob(
  admin: SupabaseClient,
  job: LeasedJob,
  opts: { state: string; delaySeconds: number; providerRef?: string; error?: string },
): Promise<boolean> {
  const runAfter = new Date(Date.now() + opts.delaySeconds * 1000).toISOString();
  const { data, error } = await admin.rpc('fn_release_job', {
    p_job: job.id,
    p_lease: job.leaseToken,
    p_run_after: runAfter,
    p_state: opts.state,
    p_provider_ref: opts.providerRef ?? null,
    p_error: opts.error ?? null,
  });
  if (error) {
    console.error('release_failed', job.id, error.message);
    return false;
  }
  return data === true;
}
```

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs/lease_test.ts
```

Expected: `4 passed | 0 failed`.

- [ ] **Step 3: Write the failing dispatch test**

Create `supabase/functions/_shared/jobs/dispatch_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, TEST_USER, fakeAdapter } from '../testing/fakes.ts';
import { MAX_JOB_ATTEMPTS, runJob } from './dispatch.ts';
import type { LeasedJob } from './lease.ts';

function job(over: Partial<LeasedJob> = {}): LeasedJob {
  return {
    id: 'j1', userId: TEST_USER, generationId: 'g1', provider: 'fal',
    providerRef: null, state: 'ready', attempts: 1, leaseToken: 'lease-1',
    payload: { familyId: 'flux', op: 'generate', prompt: 'a cat', settings: {}, safetyId: 'sha' },
    ...over,
  };
}

function deps(db: FakeDb, adapter: ReturnType<typeof fakeAdapter>) {
  db.rpcHandlers.fn_release_job = () => true;
  db.rpcHandlers.fn_settle_job = (args, self) => {
    self.tables.settled ??= [];
    self.tables.settled.push({ ...args });
    return { settled: true, previous: 'pending', refunded: 40 };
  };
  return {
    admin: db as never,
    adapterFor: () => adapter.adapter,
    storageFor: () => ({ put: () => Promise.resolve(), delete: () => Promise.resolve() }) as never,
  };
}

Deno.test('a ready job is submitted and its provider ref recorded', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({ submit: () => Promise.resolve({ providerRef: 'req_1' }) });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'submitted');
  assertEquals(adapter.submits.length, 1);
  const release = db.rpcCalls.find((r) => r.name === 'fn_release_job')!;
  assertEquals(release.args.p_provider_ref, 'req_1');
  assertEquals(release.args.p_state, 'submitted');
});

Deno.test('a submitted job is polled, not re-submitted', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({ check: { state: 'running', progress: 0.3 } });
  const outcome = await runJob(deps(db, adapter), job({ state: 'submitted', providerRef: 'req_1' }));
  assertEquals(outcome, 'running');
  assertEquals(adapter.submits.length, 0);
  assertEquals(adapter.checks, ['req_1']);
});

Deno.test('a retryable submit failure defers with backoff and does NOT settle', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({ submit: () => Promise.reject(new Error('fal submit 429: slow down')) });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'deferred');
  assertEquals(db.tables.settled ?? [], []);
  const release = db.rpcCalls.find((r) => r.name === 'fn_release_job')!;
  assertEquals(release.args.p_state, 'ready');
});

Deno.test('a terminal submit failure settles failed', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({ submit: () => Promise.reject(new Error('fal submit 400: bad prompt')) });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'settled');
  assertEquals(db.tables.settled[0].p_outcome, 'failed');
});

Deno.test('exhausting the attempt budget settles failed rather than retrying forever', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({ submit: () => Promise.reject(new Error('fal submit 503: down')) });
  const outcome = await runJob(deps(db, adapter), job({ attempts: MAX_JOB_ATTEMPTS }));
  assertEquals(outcome, 'settled');
  assertEquals(db.tables.settled[0].p_outcome, 'failed');
});

Deno.test('AMBIGUITY: a submit whose outcome is unknown never dispatches twice', async () => {
  const db = new FakeDb();
  // A submit that timed out after the provider probably accepted it.
  const adapter = fakeAdapter({
    submit: () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
  });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'deferred');
  const release = db.rpcCalls.find((r) => r.name === 'fn_release_job')!;
  // Stays in the SUBMITTED state with no ref: the next tick reconciles by
  // asking the provider, it does not blindly submit again.
  assertEquals(release.args.p_state, 'submitted');
});

Deno.test('losing the lease mid-flight abandons the work instead of settling', async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_release_job = () => false;
  const adapter = fakeAdapter({ submit: () => Promise.resolve({ providerRef: 'req_1' }) });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'submitted');
  assertEquals(db.tables.settled ?? [], []);
});

Deno.test('an inline result settles immediately', async () => {
  const db = new FakeDb();
  const adapter = fakeAdapter({
    submit: () =>
      Promise.resolve({
        providerRef: 'inline',
        inline: { state: 'done', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      }),
  });
  const outcome = await runJob(deps(db, adapter), job());
  assertEquals(outcome, 'settled');
  assertEquals(db.tables.settled[0].p_outcome, 'done');
});
```

- [ ] **Step 4: Run to verify it fails, then write `dispatch.ts`**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs/dispatch_test.ts
```

Expected: FAIL — module not found. Then create `supabase/functions/_shared/jobs/dispatch.ts`:

```ts
// One job, one tick of work: submit it if it has not been submitted, poll it if
// it has, settle it when the provider is done.
//
// The rule that matters most here is what happens when a submit's outcome is
// UNKNOWN — a timeout, a dropped connection. The provider may well have
// accepted the request and started billing. Submitting again would pay twice
// and orphan one of the results, so an ambiguous submit moves the job to
// `submitted` with no ref and the next tick reconciles by asking the provider
// rather than by guessing.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { classifyProviderError } from '../providers/provider-errors.ts';
import type { ProviderAdapter, SubmitCtx } from '../providers/types.ts';
import { isUrlResult } from '../providers/types.ts';
import { backoffSeconds, releaseJob, type LeasedJob } from './lease.ts';

export const MAX_JOB_ATTEMPTS = 8;

export interface JobDeps {
  admin: SupabaseClient;
  adapterFor(familyId: string): ProviderAdapter;
  /** Storage + settlement, injected so the worker and the gateway share them. */
  finish(job: LeasedJob, result: Awaited<ReturnType<ProviderAdapter['check']>>): Promise<'settled' | 'running'>;
}

export type JobOutcome = 'submitted' | 'running' | 'settled' | 'deferred';

function isAmbiguous(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'TimeoutError') return true;
  if (!(e instanceof Error)) return false;
  const lower = e.message.toLowerCase();
  // A transport that died after the request left us: we cannot know whether
  // the provider accepted it.
  return lower.includes('timed out') || lower.includes('connection closed') ||
    lower.includes('connection reset');
}

async function giveUp(deps: JobDeps, job: LeasedJob, message: string): Promise<JobOutcome> {
  const { settleFailed } = await import('../../api/services/job-settlement.ts');
  await settleFailed(deps.admin, job.id, message);
  return 'settled';
}

export async function runJob(deps: JobDeps, job: LeasedJob): Promise<JobOutcome> {
  const familyId = String(job.payload.familyId ?? '');
  const adapter = deps.adapterFor(familyId);

  if (job.state === 'submitted' && job.providerRef && job.providerRef !== 'inline') {
    const result = await adapter.check(job.providerRef).catch((e) => {
      console.error('check_failed', job.id, e);
      return { state: 'retryable_failure' as const, error: String(e).slice(0, 200) };
    });
    if (result.state === 'running' || result.state === 'retryable_failure') {
      await releaseJob(deps.admin, job, {
        state: 'submitted',
        delaySeconds: result.state === 'running' ? 5 : backoffSeconds(job.attempts),
      });
      return 'running';
    }
    const finished = await deps.finish(job, result);
    return finished === 'settled' ? 'settled' : 'running';
  }

  if (job.attempts > MAX_JOB_ATTEMPTS) {
    return await giveUp(deps, job, 'max_attempts');
  }

  try {
    const submitted = await adapter.submit(job.payload as unknown as SubmitCtx);
    if (submitted.inline) {
      await deps.finish(job, submitted.inline);
      await releaseJob(deps.admin, job, { state: 'done', delaySeconds: 0, providerRef: 'inline' });
      return 'settled';
    }
    const kept = await releaseJob(deps.admin, job, {
      state: 'submitted',
      delaySeconds: 5,
      providerRef: submitted.providerRef,
    });
    if (!kept) {
      // Our lease expired while the provider was answering. Another worker
      // owns this job now; do not settle over it.
      console.warn('lease_lost_after_submit', job.id, submitted.providerRef);
    }
    return 'submitted';
  } catch (e) {
    if (isAmbiguous(e)) {
      // Might already be running at the provider. Ask next tick; never resubmit.
      await releaseJob(deps.admin, job, {
        state: 'submitted',
        delaySeconds: backoffSeconds(job.attempts),
        error: 'submit_ambiguous',
      });
      return 'deferred';
    }
    if (classifyProviderError(e) === 'terminal') {
      return await giveUp(deps, job, String(e).slice(0, 500));
    }
    if (job.attempts >= MAX_JOB_ATTEMPTS) {
      return await giveUp(deps, job, String(e).slice(0, 500));
    }
    await releaseJob(deps.admin, job, {
      state: 'ready',
      delaySeconds: backoffSeconds(job.attempts),
      error: String(e).slice(0, 500),
    });
    return 'deferred';
  }
}
```

The `deps.finish` seam exists because storing bytes needs the gateway's `finishJob` (P4), which knows about the `media` bucket and R2. The worker passes its own binding in Task 4; the tests pass a fake.

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/jobs
```

Expected: `12 passed | 0 failed`. Adjust the test `deps` helper so it supplies a `finish` that records into `db.tables.settled` via `fn_settle_job`. User commits.

---

## Task 4: The gateway reserves, the worker dispatches

**Files:**
- Modify: `supabase/functions/api/app.ts`
- Create: `supabase/functions/job-worker/index.ts`, `handler.ts`, `handler_test.ts`, `deno.json`; symlink `supabase/functions/job-worker/_shared → ../_shared`
- Create: `supabase/functions/api/dispatch_routes_test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /generations` returns accepted jobs without waiting for a provider; `GET /jobs` performs no provider calls.

- [ ] **Step 1: Create the worker function directory**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && mkdir -p job-worker && ln -s ../_shared job-worker/_shared && ls -la job-worker/
```

The symlink is how `api`, `stripe-webhook` and `appstore-webhook` already bundle `_shared`; the worker must follow the same pattern or its deploy will miss `providers/`.

- [ ] **Step 2: Write the failing worker test**

Create `supabase/functions/job-worker/handler_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, TEST_USER, fakeAdapter } from './_shared/testing/fakes.ts';
import { createWorker } from './handler.ts';

function db(): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_release_job = () => true;
  d.rpcHandlers.fn_settle_job = (args, self) => {
    self.tables.settled ??= [];
    self.tables.settled.push({ ...args });
    return { settled: true, previous: 'pending', refunded: 0 };
  };
  return d;
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: 'j1', user_id: TEST_USER, generation_id: 'g1', provider: 'fal',
    provider_ref: null, state: 'ready', attempts: 1, lease_token: 'lease-1',
    payload: { familyId: 'flux', op: 'generate', prompt: 'a cat', settings: {}, safetyId: 'sha' },
    ...over,
  };
}

function deps(d: FakeDb, adapter: ReturnType<typeof fakeAdapter>) {
  return {
    admin: d as never,
    adapterFor: () => adapter.adapter,
    storageFor: () => ({ put: () => Promise.resolve(), delete: () => Promise.resolve() }) as never,
    workerId: 'worker-test',
  };
}

Deno.test('the worker claims and dispatches without any client present', async () => {
  const d = db();
  d.rpcHandlers.fn_claim_jobs = () => [jobRow()];
  const adapter = fakeAdapter({ submit: () => Promise.resolve({ providerRef: 'req_1' }) });
  const res = await createWorker(deps(d, adapter))(new Request('https://x/', { method: 'POST' }));
  assertEquals(res.status, 200);
  assertEquals(adapter.submits.length, 1);
  assertEquals((await res.json()).processed, 1);
});

Deno.test('an empty queue is a fast no-op', async () => {
  const d = db();
  d.rpcHandlers.fn_claim_jobs = () => [];
  const adapter = fakeAdapter();
  const res = await createWorker(deps(d, adapter))(new Request('https://x/', { method: 'POST' }));
  assertEquals((await res.json()).processed, 0);
  assertEquals(adapter.submits.length, 0);
});

Deno.test('one failing job does not stop the batch', async () => {
  const d = db();
  d.rpcHandlers.fn_claim_jobs = () => [
    jobRow({ id: 'j1' }),
    jobRow({ id: 'j2', payload: { familyId: 'flux', op: 'generate', prompt: 'b', settings: {}, safetyId: 'sha' } }),
  ];
  let calls = 0;
  const adapter = fakeAdapter({
    submit: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('fal submit 400: bad'));
      return Promise.resolve({ providerRef: 'req_2' });
    },
  });
  const res = await createWorker(deps(d, adapter))(new Request('https://x/', { method: 'POST' }));
  assertEquals((await res.json()).processed, 2);
  assertEquals(calls, 2);
});

Deno.test('a GET is refused — the worker is a cron target, not a public endpoint', async () => {
  const d = db();
  d.rpcHandlers.fn_claim_jobs = () => [];
  const res = await createWorker(deps(d, fakeAdapter()))(new Request('https://x/'));
  assertEquals(res.status, 405);
});
```

- [ ] **Step 3: Run to verify it fails, then write the worker**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all job-worker/handler_test.ts
```

Expected: FAIL — module not found. Then create `supabase/functions/job-worker/handler.ts`:

```ts
// Moves jobs forward without a browser.
//
// Until this function existed, every provider poll happened inside GET /jobs:
// a customer who closed the tab after submitting a two-minute video got no
// result until they returned, and the 30-minute stale sweep refunded jobs that
// had actually succeeded. A cron calls this every minute instead.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { claimJobs, type LeasedJob } from './_shared/jobs/lease.ts';
import { runJob, type JobDeps } from './_shared/jobs/dispatch.ts';
import { settleDone, settleFailed } from './_shared/../api/services/job-settlement.ts';
import { isUrlResult, type CheckResult } from './_shared/providers/types.ts';
import type { StorageAdapter, StorageBackend } from './_shared/storage/index.ts';

export interface WorkerDeps {
  admin: SupabaseClient;
  adapterFor(familyId: string): JobDeps['adapterFor'] extends (id: string) => infer R ? R : never;
  storageFor(backend: StorageBackend): StorageAdapter;
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
}

export function createWorker(deps: WorkerDeps): (req: Request) => Promise<Response> {
  const batchSize = deps.batchSize ?? 5;
  const leaseSeconds = deps.leaseSeconds ?? 120;

  async function finish(job: LeasedJob, result: CheckResult): Promise<'settled' | 'running'> {
    if (result.state === 'running' || result.state === 'retryable_failure') return 'running';
    if (result.state === 'failed') {
      await settleFailed(deps.admin, job.id, result.error);
      return 'settled';
    }
    if (isUrlResult(result)) {
      // Video: pull the bytes to R2, then settle. Bounded the same way the
      // gateway bounds it (see MAX_VIDEO_BYTES).
      const { storeUrlResult } = await import('./_shared/jobs/store.ts');
      return await storeUrlResult(deps, job, result);
    }
    const path = `${job.userId}/${job.generationId}.png`;
    const { error } = await deps.admin.storage
      .from('media')
      .upload(path, result.bytes, { contentType: result.contentType, upsert: true });
    if (error) {
      await settleFailed(deps.admin, job.id, 'store_failed');
      return 'settled';
    }
    const outcome = await settleDone(deps.admin, job.id, { path, backend: 'supabase' });
    if (!outcome.settled) {
      await deps.admin.storage.from('media').remove([path]).catch(() => undefined);
    }
    return 'settled';
  }

  return async function serve(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const jobs = await claimJobs(deps.admin, deps.workerId, batchSize, leaseSeconds);
    let processed = 0;
    for (const job of jobs) {
      try {
        await runJob({ admin: deps.admin, adapterFor: deps.adapterFor as never, finish }, job);
      } catch (e) {
        // One broken job must never stop the queue; its lease expires and it
        // comes back.
        console.error('worker_job_failed', job.id, e);
      }
      processed += 1;
    }
    return Response.json({ processed, claimed: jobs.length });
  };
}
```

Create `supabase/functions/job-worker/index.ts`:

```ts
// Production composition for the job worker. Behaviour lives in handler.ts.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { adapterFor } from './_shared/providers/index.ts';
import { storageFor } from './_shared/storage/index.ts';
import { createWorker } from './handler.ts';

Deno.serve(createWorker({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  adapterFor,
  storageFor,
  workerId: crypto.randomUUID(),
  batchSize: Number(Deno.env.get('WORKER_BATCH') ?? 5),
}));
```

Extract the URL-result storage into `supabase/functions/_shared/jobs/store.ts` so the gateway's `storeVideoResult` (P4 Task 5) and the worker share exactly one implementation, including the `MAX_VIDEO_BYTES` cap and the content-type check. Move the body there and have `app.ts` call it.

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check job-worker/index.ts && deno test --allow-all job-worker
```

Expected: `4 passed | 0 failed`.

- [ ] **Step 4: Write the failing gateway test**

Create `supabase/functions/api/dispatch_routes_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const KEY = '33333333-3333-4333-8333-333333333333';

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.submissions = [];
  db.rpcHandlers.fn_reserve_generation = (args, self) => {
    const key = String(args.p_key);
    const prior = (self.tables.submissions ?? []).find((s) => s.idempotency_key === key);
    if (prior) return { ...(prior.result as Record<string, unknown>), replay: true };
    const items = (args.p_items as Record<string, unknown>[]).map((item, i) => ({
      id: `g${i}`, user_id: TEST_USER, kind: item.kind, family_id: item.familyId,
      family_name: item.familyName, op: item.op, prompt: item.prompt, settings: item.settings,
      price_credits: item.priceCredits, status: 'pending', media_path: null,
    }));
    const result = { replay: false, items, credits: { plan: 1000, pack: 0 } };
    self.tables.submissions.push({ idempotency_key: key, body_hash: args.p_body_hash, result });
    return result;
  };
}

function body() {
  return JSON.stringify({
    op: 'generate', familyId: 'flux', prompt: 'a cat', batch: 1,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
  });
}

Deno.test('R07: the same key and body charges once', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  const headers = { ...AUTH, 'content-type': 'application/json', 'idempotency-key': KEY };

  const first = await app.request('/api/generations', { method: 'POST', headers, body: body() });
  const second = await app.request('/api/generations', { method: 'POST', headers, body: body() });

  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_reserve_generation').length, 2);
  assertEquals(db.tables.submissions.length, 1, 'one reservation, two requests');
  const a = (await first.json()).items[0].id;
  const b = (await second.json()).items[0].id;
  assertEquals(a, b, 'a replay returns the original generation');
});

Deno.test('R07: the same key with a different body is a conflict', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.rpcHandlers.fn_reserve_generation = () => {
    throw new Error('idempotency_conflict');
  };
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'idempotency-key': KEY },
    body: body(),
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'idempotency_conflict');
});

Deno.test('R06: the response returns before the provider answers', async () => {
  let resolveSubmit: (v: { providerRef: string }) => void = () => {};
  const provider = fakeAdapter({
    submit: () => new Promise((resolve) => {
      resolveSubmit = resolve;
    }),
  });
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'idempotency-key': KEY },
    body: body(),
  });

  assertEquals(res.status, 200);
  assertEquals((await res.json()).items[0].status, 'pending');
  resolveSubmit({ providerRef: 'req_1' });
});

Deno.test('R06: GET /jobs makes no provider calls', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'g0', user_id: TEST_USER, kind: 'image', family_id: 'flux', status: 'pending', settings: {}, price_credits: 40, media_path: null },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: TEST_USER, generation_id: 'g0', provider_ref: 'req_1', error: null, state: 'submitted', created_at: '2026-09-20T00:00:00Z' },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/jobs?ids=g0', { headers: AUTH });

  assertEquals(res.status, 200);
  assertEquals(provider.checks, [], 'polling is the worker\'s job now');
  assertEquals(provider.submits, []);
});

Deno.test('a request with no idempotency key still works', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: body(),
  });
  assertEquals(res.status, 200);
});

Deno.test('the daily cap is reported with a reset time', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.models = [{ id: 'kling', enabled: true, min_plan: 'pro' }];
  db.rpcHandlers.fn_reserve_generation = () => {
    throw new Error('daily_cap:2026-09-21T00:00:00+00:00');
  };
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate', familyId: 'kling', prompt: 'v', batch: 1,
      settings: { aspectRatio: '16:9', mode: 't2v', durationS: 5 },
    }),
  });
  assertEquals(res.status, 429);
  const err = (await res.json()).error;
  assertEquals(err.code, 'daily_cap');
  assertEquals(typeof err.resetsAt, 'string');
});
```

- [ ] **Step 5: Run to verify it fails, then rewrite `POST /generations`**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/dispatch_routes_test.ts
```

Expected: FAIL — the route still calls `fn_charge_and_generate` and submits inline.

Replace the charge-and-dispatch tail of `POST /generations` with:

```ts
  // One transaction: replay-check, caps, charge, generations, jobs. A crash
  // anywhere in here leaves nothing behind — no charge without a job, no job
  // without a charge, and no cap passed by four requests at once.
  const key = readIdempotencyKey(c);
  const hash = await bodyHash(body);
  const caps = {
    isVideo: !!video,
    maxPendingVideos: MAX_PENDING_VIDEO_JOBS,
    videoDailyCapUsd: VIDEO_DAILY_CAP_USD,
    provider: adapterFor(familyId).provider,
    providerCostUsd: providerCostUsd * batch,
  };
  const { data: reserved, error: reserveError } = await admin.rpc('fn_reserve_generation', {
    p_user: userId,
    p_key: key,
    p_body_hash: hash,
    p_amount: priceCredits * batch,
    p_type: op,
    p_family_id: familyId,
    p_note: effectivePrompt.slice(0, 200),
    p_items: items,
    p_caps: caps,
  });
  if (reserveError) return reservationFailure(c, reserveError.message);

  const result = reserved as { replay: boolean; items: Record<string, unknown>[]; credits: { plan: number; pack: number } };
  // The worker takes it from here. Returning now is what makes "you can close
  // this page" true.
  await drainOutbox(userId);
  return c.json({
    items: await toGenerationDtos(result.items),
    credits: result.credits,
  });
```

Add the failure translator inside `createApp`:

```ts
  /** Reservation errors carry the reason in the message; each has its own
   * status and its own sentence, because "charge failed" told the customer
   * nothing about whether to wait, top up, or change the request. */
  function reservationFailure(c: Context, message: string): Response {
    if (message.includes('insufficient_balance')) {
      return fail(c, 402, 'insufficient_credits', 'Not enough credits for this run');
    }
    if (message.includes('idempotency_conflict')) {
      return fail(c, 409, 'idempotency_conflict', 'That request id was already used for a different request.');
    }
    if (message.includes('too_many_jobs')) {
      return fail(c, 429, 'too_many_jobs', '3 videos are still rendering — wait for one to finish');
    }
    if (message.startsWith('daily_cap:') || message.includes('daily_cap:')) {
      const resetsAt = message.split('daily_cap:')[1]?.trim() ?? null;
      return c.json(
        { error: { code: 'daily_cap', message: 'Daily video limit reached.', resetsAt } },
        429,
      );
    }
    logError(c, 'reserve_failed', new Error(message));
    return fail(c, 400, 'charge_failed', 'Charge could not be completed');
  }
```

Delete the `for (const gen of created)` dispatch loop entirely, and delete the now-unreachable pre-charge cap checks in `prepareVideo` (evidence lines 964–990) — leaving them would mean checking the same limit twice with two different answers.

Build the `payload` for each item as the exact `SubmitCtx` the worker will send, and put it on the item so `fn_reserve_generation` stores it on the job row:

```ts
    const payload: SubmitCtx = {
      familyId, op, prompt: effectivePrompt, settings, normalized,
      referenceUrl, maskPngBase64, loraUrl: persona?.lora_url,
      safetyId: sid, mode: video?.mode, referenceUrls: video?.referenceUrls,
      parentVideoUrl: video?.parentVideoUrl, interactionId: video?.interactionId,
    };
```

**Signed URLs in a stored payload have a lifetime.** `REF_SIGN_TTL_S` is one hour; a job deferred past that will submit a dead reference. Store the **object paths** in the payload and have the worker re-sign them at submit time. Add to the worker's `runJob` path a `resolvePayload` step that turns `referencePaths` into fresh signed URLs before calling `submit`. Write a test for it:

```ts
Deno.test('a deferred job re-signs its references rather than using a stale url', async () => {
  // ... claim a job whose payload carries referencePaths, assert the SubmitCtx
  // the adapter received has freshly signed referenceUrls.
});
```

- [ ] **Step 6: Make `GET /jobs` read-only**

Delete the whole `for (const job of jobs ?? [])` provider-check block. The route becomes:

```ts
app.get('/jobs', async (c) => {
  const userId = c.get('userId');
  const idsParam = c.req.query('ids') ?? '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return c.json({ items: [] });

  // A read-only view of lifecycle state. The worker moves jobs forward, so a
  // client that never polls still gets its result — polling is only freshness.
  const { data: jobs } = await admin
    .from('jobs')
    .select('id,generation_id,progress,phase,state,created_at,queue_position')
    .eq('user_id', userId)
    .in('generation_id', ids);
  const jobsByGen = new Map<string, JobRow>((jobs ?? []).map((j) => [j.generation_id, j as JobRow]));
  const { data: gens } = await admin.from('generations').select('*').eq('user_id', userId).in('id', ids);
  await drainOutbox(userId);
  return c.json({ items: await toGenerationDtos(gens ?? [], jobsByGen) });
});
```

- [ ] **Step 7: Move persona training onto the worker too**

`POST /personas/:id/train` submits to fal inline and settles in `GET /personas`. Give it a job row with `payload.kind = 'persona_training'` and let `runJob` branch on it, calling `submitPersonaTraining` / `checkPersonaTraining`. Add a test asserting a persona reaches `ready` with no client request between submit and completion.

- [ ] **Step 8: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts job-worker/index.ts && deno test --allow-all _shared api job-worker stripe-webhook appstore-webhook
```

Expected: all green. User commits.

---

## Task 5: Schedule the worker and restore the promise

**Files:**
- Modify: `supabase/migrations/0020_durable_dispatch.sql` (add the worker cron), web copy that currently avoids promising background completion
- Create: `docs/superpowers/plans/2026-09-20-dispatch-verification-log.md`

- [ ] **Step 1: Add the worker cron to the migration**

Append to `0020_durable_dispatch.sql`:

```sql
-- Drive the worker once a minute. The function URL and the service-role key
-- are set as database settings by the release runbook (P9), NOT here — a
-- migration must never contain a key.
--   alter database postgres set app.job_worker_url = 'https://<ref>.supabase.co/functions/v1/job-worker';
--   alter database postgres set app.service_role_key = '<key>';
select cron.unschedule(jobid) from cron.job where jobname = 'drive_job_worker';
select cron.schedule('drive_job_worker', '* * * * *', $$
  select net.http_post(
    url := current_setting('app.job_worker_url', true),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := '{}'::jsonb
  )
  where current_setting('app.job_worker_url', true) is not null;
$$);
```

Confirm `pg_net` is available on this project before relying on `net.http_post`:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -t -A -c "select extname from pg_extension where extname in ('pg_net','pg_cron');"
```

Expected: both names. If `pg_net` is absent, add `create extension if not exists pg_net;` to the migration and re-run.

- [ ] **Step 2: Write the offline-completion rehearsal log**

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
| A provider that never answers | Retried with backoff to `MAX_JOB_ATTEMPTS`, then settled failed once and refunded once |
| A reference whose signed URL would have expired | Re-signed at submit time; the provider receives a working URL |

- [ ] **Step 3: Restore the "you can leave this page" copy**

Search the web client for copy that was written around the old constraint:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "keep this page\|stay on this page\|don't close\|do not close\|leave this page" src/app --include=*.html --include=*.ts
```

For each hit, separate **D3 background completion** from **D6 completion notifications**. This plan prepares capability-gated copy but does not deploy it: production may show background-completion wording only after P9 confirms the deployed worker and offline-completion rehearsal. A local rehearsal alone cannot change the live promise.

Add a failing copy/capability test with these cases before changing the UI:

| Verified capability state | Permitted wording |
|---|---|
| Worker absent or offline-completion evidence missing | Do not promise that work completes after every client closes |
| Deployed worker and offline completion verified; notification prerequisites incomplete | “You can leave this page and return to check the result.” |
| P4 outbox + P5 offline completion + mobile MT-04 delivery and client receipt verified | Notification wording may be enabled after P9 Task 6 records D6 PASS |

Keep “We'll notify you” unavailable on both platforms until the source spec's D6 prerequisites pass. Prove outbox retry after a send failure and duplicate handling; link actual background/closed-client receipt from MT-04 in the release record. Permission-denied clients must receive truthful recovery guidance. Job lease ownership remains a lifecycle implementation detail, not a redefinition of D6. Run the copy tests GREEN after wiring the release capability state, retaining the existing visual composition.

- [ ] **Step 4: Final run**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api job-worker stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f tests/dispatch.sql && ./tests/caps_concurrency.sh
```

Expected: all green. User commits.

---

## Exit criteria for P5

- [ ] A generation submitted with every client then closed reaches `done` with retrievable media, driven only by the worker.
- [ ] The same idempotency key and body charges once and returns the original generation; the same key with a different body returns 409.
- [ ] No `pending` generation exists without a job row — asserted by a SQL check after the rehearsal.
- [ ] Four concurrent video submissions produce exactly three pending videos, proven three times by `caps_concurrency.sh`.
- [ ] A refunded job's provider cost still counts against the daily budget.
- [ ] A submit whose outcome is unknown is reconciled by asking the provider, never by submitting again.
- [ ] A worker whose lease expired cannot settle over the worker that took over.
- [ ] `GET /jobs` makes zero provider calls.
- [ ] A job deferred past the signed-URL lifetime re-signs its references before submitting.
- [ ] D3 copy is gated on deployed, verified background completion; D6 notification copy remains unavailable until P4/P5 and mobile MT-04 delivery/receipt evidence passes in P9 Task 6.

**Known carry-forward:** deleting an account or a generation still leaves stored objects behind — P6. The `job-worker` function is written and tested but **not deployed**, and its cron settings are not set; P9 does both.
