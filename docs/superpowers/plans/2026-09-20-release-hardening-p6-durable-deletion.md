# Release Hardening P6 — Durable Deletion and Storage Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer deletes a generation, a persona or their whole account, the bytes actually go — in both storage backends, eventually and verifiably — and we can prove at any moment that no stored object outlives the row that owned it.

**Architecture:** Deletion stops being a best-effort loop inside a request. Every delete records the objects it orphaned into a `deletion_outbox` in the same transaction that removes the rows, and a cleanup worker drains that outbox with retries against Supabase Storage or R2. `fn_delete_account` and the lapsed-library purge, which today delete rows and nothing else, enqueue instead. A read-only inventory script reconciles storage against the database so the claim "deleted means deleted" is measured, not asserted.

**Tech Stack:** Postgres (plpgsql, triggers, `pg_cron`), Deno, Supabase Storage, Cloudflare R2.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T08**, closing **R11** and resolving decision **D2** (retention). It depends on P1 (test seam, upload registry `0017`) and P5 (worker pattern, `0020`). It is a prerequisite for P9's release gates.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** P1 `0017`, P2 `0018`, P4 `0019`, P5 `0020`. This plan adds `0021`. Confirm the applied inventory first; never renumber an applied migration.
- **New RPCs are service_role-only.**
- **Never delete an object before the row that references it is gone.** The other order can strand a live row pointing at nothing, which looks to the customer like data loss.
- **Never let a storage failure block a row delete.** The customer asked for their data to be removed; a bad minute at the storage provider must not refuse them.
- **A delete is only complete when both halves are done.** Dropping the row and hoping about the object is what R11 is.
- **Account deletion is legally load-bearing.** It must be idempotent, resumable, and auditable. An account delete that half-ran and reported success is worse than one that failed loudly.
- **Deleting a pending generation must cancel its job first** (P4/P5 semantics), or the worker will settle a row that no longer exists.
- **Redeploying `api` must bundle every `_shared/` file.**
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`). Angular → `npm test -- --watch=false`.

---

## The defects in one paragraph

`fn_delete_account` is, in its entirety, `delete from public.profiles where id = p_user;` (`0001_foundation_schema.sql:102-105`). The cascade removes the rows; **every generated image, every video in R2, every persona training photo and every LoRA stays exactly where it was**, and the row that named its path is gone, so nothing in the system can ever find it again. The daily `purge_lapsed_libraries` cron (`0013_personas.sql:103-114`) has the same shape: it deletes `generations` and `personas` rows for lapsed subscribers with raw SQL and touches no storage. `DELETE /generations/:id` (`api/index.ts:2035-2057`) at least tries — but it deletes the row **first**, then deletes objects in a loop whose failures are logged and swallowed, so a storage hiccup leaves an object nobody can name. Persona deletion never removes `photo_paths` or the LoRA at all. And `storage_backend` exists only on `generations` (`0016_video.sql:6-7`), so nothing records which backend a persona's or an upload's object lives in.

---

## File Structure

**New:**
- `supabase/migrations/0021_durable_deletion.sql` — `deletion_outbox`, `fn_enqueue_deletions`, `fn_claim_deletions`, `fn_complete_deletion`, rewritten `fn_delete_account` and `fn_purge_lapsed`, `account_deletions` audit, backend columns.
- `supabase/tests/deletion.sql` — transactional proofs.
- `supabase/functions/_shared/storage/deletion-service.ts` + `_test.ts`.
- `supabase/functions/cleanup-worker/index.ts`, `handler.ts`, `handler_test.ts`, `deno.json`, `_shared` symlink.
- `scripts/storage-inventory.mjs` — read-only orphan/leak reconciliation.
- `docs/superpowers/specs/2026-09-20-retention-policy.md` — the D2 decision, written down.

**Modified:**
- `supabase/functions/api/app.ts` — `DELETE /generations/:id`, `DELETE /personas/:id`, `deleteAccount`, `/library/import`, `/edits/save`.
- `src/app/features/settings/**` — delete-account copy matching what actually happens.

---

## Task 1: Decide and write down the retention policy (D2)

**Files:**
- Create: `docs/superpowers/specs/2026-09-20-retention-policy.md`

**This task is blocking.** Every later task reads its numbers. Do not guess them; the answers change what the cron deletes and how long a customer can recover.

- [ ] **Step 1: Gather what the product currently promises**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "delete\|deletion\|retain\|retention\|30 day\|30-day" src/app/features/settings src/app/features/legal vansen.md --include=*.html --include=*.ts --include=*.md 2>/dev/null | head -40
```

Record every promise found, with its file and line. A policy that contradicts shipped copy is a policy that has to change the copy too.

- [ ] **Step 2: Write the spec with the decisions filled in**

Create `docs/superpowers/specs/2026-09-20-retention-policy.md`:

```markdown
# Retention and Deletion Policy (decision D2)

Written 2026-09-20. Every number here is enforced by `0021_durable_deletion.sql`
and asserted by `supabase/tests/deletion.sql`. Changing a number means changing
both, plus the customer-facing copy listed at the bottom.

## What each deletion actually removes

| Action | Rows | Objects | Ledger | Auth user |
|---|---|---|---|---|
| Delete one generation | the row | media + thumb | kept | kept |
| Delete a persona | the row | training photos + LoRA | kept | kept |
| Delete account | profile cascade | every object the account owned | **kept, anonymised** | deleted |
| Lapse purge (day 31) | generations + personas | their objects | kept | kept |

The ledger survives account deletion because it is financial history: refunds,
chargebacks and tax records need it. It is anonymised — `user_id` is repointed
at a tombstone — rather than deleted. Say this in the delete-account dialog.

## The grace window

- Soft-delete window: **<DECIDE: 0 or N days>**. If 0, a delete is immediate and
  irreversible and the UI must say so without hedging.
- Lapse grace before purge: **30 days** after `current_period_end` (already shipped).
- Outbox retry budget: **<DECIDE: attempts>** over **<DECIDE: window>**, after
  which a stuck object is alerted on, never silently dropped.

## What "deleted" means to a customer

<DECIDE: the exact sentence shown in the settings dialog. It must be true of
the table above — in particular about the ledger and about the grace window.>

## Copy that must match this policy

<Paste the grep results from Step 1 here, each marked OK or NEEDS-CHANGE.>
```

- [ ] **Step 3: Resolve every `<DECIDE:>` with the user**

Present the open choices with a recommendation each. Do not proceed to Task 2 until no `<DECIDE:` remains:

```bash
cd /Users/user/IdeaProjects/vansen && ! grep -q "<DECIDE:" docs/superpowers/specs/2026-09-20-retention-policy.md && echo "POLICY DECIDED"
```

Expected: `POLICY DECIDED`. User commits.

---

## Task 2: The deletion outbox

**Files:**
- Create: `supabase/migrations/0021_durable_deletion.sql`, `supabase/tests/deletion.sql`

**Interfaces:**
- Produces:
  ```sql
  public.deletion_outbox (id, user_id, backend, object_path, reason, attempts,
                          run_after, claimed_by, claim_expires_at, last_error, created_at)
                          unique (backend, object_path)
  public.account_deletions (user_id, requested_at, rows_deleted_at, objects_total,
                            objects_done, completed_at)
  public.fn_enqueue_deletions(p_user uuid, p_objects jsonb, p_reason text) returns int
  public.fn_delete_generation(p_user uuid, p_generation uuid) returns jsonb   -- rewritten path
  public.fn_delete_persona(p_user uuid, p_persona uuid) returns jsonb
  public.fn_delete_account(p_user uuid) returns jsonb                          -- REWRITTEN
  public.fn_claim_deletions(p_worker uuid, p_limit int, p_lease_seconds int) returns setof public.deletion_outbox
  public.fn_complete_deletion(p_id uuid, p_worker uuid) returns boolean
  public.fn_defer_deletion(p_id uuid, p_worker uuid, p_delay_seconds int, p_error text) returns boolean
  ```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0021_durable_deletion.sql`:

```sql
-- 0021: deletion that finishes.
--
-- fn_delete_account was one statement — delete from profiles — so a customer
-- exercising their right to erasure had their rows cascade away while every
-- image, video, training photo and LoRA they ever made stayed in the bucket,
-- now unreferenced and unfindable. purge_lapsed_libraries had the same hole.
-- DELETE /generations/:id tried, but deleted the row first and swallowed
-- storage errors, so one bad minute produced a permanent orphan.
--
-- The fix is to make the object list part of the same transaction that removes
-- the rows: the row and the intent-to-delete-its-bytes commit together, and a
-- worker with retries does the slow, failure-prone half.
-- (written 2026-09-20; apply AFTER 0020_durable_dispatch.sql)

-- ── Which backend owns an object ──────────────────────────────────────────
-- generations already carries storage_backend (0016). Personas and uploads
-- did not, so nothing recorded where their bytes lived.
alter table public.personas
  add column if not exists storage_backend text not null default 'supabase'
    check (storage_backend in ('supabase', 'r2')),
  add column if not exists lora_path text;

alter table public.uploads
  add column if not exists storage_backend text not null default 'supabase'
    check (storage_backend in ('supabase', 'r2'));

-- ── The outbox ────────────────────────────────────────────────────────────
create table public.deletion_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,                       -- nullable: survives the profile cascade
  backend text not null check (backend in ('supabase', 'r2')),
  object_path text not null,
  reason text not null,
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  claimed_by uuid,
  claim_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  -- Enqueuing the same object twice is not an error; it is the same job.
  unique (backend, object_path)
);
create index deletion_outbox_runnable_idx on public.deletion_outbox (run_after);
alter table public.deletion_outbox enable row level security;

-- ── The audit trail for erasure requests ──────────────────────────────────
-- An account delete that half-ran and reported success is the worst outcome
-- available, so every one is recorded and its progress is countable.
create table public.account_deletions (
  user_id uuid primary key,
  email_hash text,
  requested_at timestamptz not null default now(),
  rows_deleted_at timestamptz,
  objects_total int not null default 0,
  completed_at timestamptz
);
alter table public.account_deletions enable row level security;

/** p_objects: [{"backend":"supabase","path":"user/gen.png"}, ...] */
create or replace function public.fn_enqueue_deletions(
  p_user uuid, p_objects jsonb, p_reason text
) returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into public.deletion_outbox (user_id, backend, object_path, reason)
  select p_user, o->>'backend', o->>'path', p_reason
    from jsonb_array_elements(coalesce(p_objects, '[]'::jsonb)) o
   where coalesce(o->>'path', '') <> ''
  on conflict (backend, object_path) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ── One generation ────────────────────────────────────────────────────────
/** Delete the row and enqueue its objects in ONE transaction. The old route
 * deleted the row, then tried the objects and swallowed the error — the order
 * that produces orphans. */
create or replace function public.fn_delete_generation(p_user uuid, p_generation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.generations; v_objects jsonb;
begin
  delete from public.generations
    where id = p_generation and user_id = p_user
    returning * into v_row;
  if not found then
    return jsonb_build_object('deleted', false);
  end if;

  v_objects := '[]'::jsonb;
  if coalesce(v_row.media_path, '') <> '' then
    v_objects := v_objects || jsonb_build_array(
      jsonb_build_object('backend', coalesce(v_row.storage_backend, 'supabase'),
                         'path', v_row.media_path));
  end if;
  if coalesce(v_row.thumb_path, '') <> '' then
    -- Posters are always Supabase-side JPEGs even when the video is in R2.
    v_objects := v_objects || jsonb_build_array(
      jsonb_build_object('backend', 'supabase', 'path', v_row.thumb_path));
  end if;

  perform public.fn_enqueue_deletions(p_user, v_objects, 'generation_deleted');
  return jsonb_build_object('deleted', true, 'objects', jsonb_array_length(v_objects));
end $$;

-- ── One persona ───────────────────────────────────────────────────────────
-- Persona deletion previously removed the row and left the training photos and
-- the LoRA behind — likeness data, which is the most sensitive thing we hold.
create or replace function public.fn_delete_persona(p_user uuid, p_persona uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.personas; v_objects jsonb;
begin
  delete from public.personas
    where id = p_persona and user_id = p_user
    returning * into v_row;
  if not found then
    return jsonb_build_object('deleted', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'backend', coalesce(v_row.storage_backend, 'supabase'), 'path', p)), '[]'::jsonb)
    into v_objects
    from jsonb_array_elements_text(coalesce(v_row.photo_paths, '[]'::jsonb)) p
   where coalesce(p, '') <> '';

  if coalesce(v_row.lora_path, '') <> '' then
    v_objects := v_objects || jsonb_build_array(
      jsonb_build_object('backend', coalesce(v_row.storage_backend, 'supabase'),
                         'path', v_row.lora_path));
  end if;

  perform public.fn_enqueue_deletions(p_user, v_objects, 'persona_deleted');
  return jsonb_build_object('deleted', true, 'objects', jsonb_array_length(v_objects));
end $$;

-- ── A whole account ───────────────────────────────────────────────────────
/** Erasure. Collects every object the account owns, enqueues them, keeps the
 * ledger as anonymised financial history, then cascades the profile.
 *
 * Idempotent: running it twice on a half-deleted account finishes the job
 * rather than failing. Resumable: the outbox survives the profile cascade,
 * which is why deletion_outbox.user_id is nullable and has no FK. */
create or replace function public.fn_delete_account(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_objects jsonb := '[]'::jsonb; v_part jsonb; v_total int;
begin
  perform pg_advisory_xact_lock(hashtext('delete:' || p_user::text));

  insert into public.account_deletions (user_id)
    values (p_user) on conflict (user_id) do nothing;

  -- 1. Generations: media + poster.
  select coalesce(jsonb_agg(o), '[]'::jsonb) into v_part from (
    select jsonb_build_object('backend', coalesce(g.storage_backend,'supabase'),
                              'path', g.media_path) as o
      from public.generations g
     where g.user_id = p_user and coalesce(g.media_path,'') <> ''
    union all
    select jsonb_build_object('backend','supabase','path', g.thumb_path)
      from public.generations g
     where g.user_id = p_user and coalesce(g.thumb_path,'') <> ''
  ) s;
  v_objects := v_objects || v_part;

  -- 2. Personas: training photos + LoRA.
  select coalesce(jsonb_agg(o), '[]'::jsonb) into v_part from (
    select jsonb_build_object('backend', coalesce(p.storage_backend,'supabase'),
                              'path', ph) as o
      from public.personas p,
           jsonb_array_elements_text(coalesce(p.photo_paths,'[]'::jsonb)) ph
     where p.user_id = p_user and coalesce(ph,'') <> ''
    union all
    select jsonb_build_object('backend', coalesce(p.storage_backend,'supabase'),
                              'path', p.lora_path)
      from public.personas p
     where p.user_id = p_user and coalesce(p.lora_path,'') <> ''
  ) s;
  v_objects := v_objects || v_part;

  -- 3. Uploaded references (registry from 0017).
  select coalesce(jsonb_agg(jsonb_build_object(
           'backend', coalesce(u.storage_backend,'supabase'), 'path', u.object_path)), '[]'::jsonb)
    into v_part
    from public.uploads u
   where u.user_id = p_user and coalesce(u.object_path,'') <> '';
  v_objects := v_objects || v_part;

  v_total := public.fn_enqueue_deletions(p_user, v_objects, 'account_deleted');

  -- 4. Keep the money history, detached from the person. Refunds, chargebacks
  --    and tax records need it; the customer's identity does not appear in it.
  update public.ledger_entries set user_id = null where user_id = p_user;
  update public.billing_transactions set user_id = null where user_id = p_user;

  -- 5. Now the rows. The outbox row has no FK to profiles precisely so this
  --    cascade cannot take the cleanup work with it.
  delete from public.profiles where id = p_user;

  update public.account_deletions
     set rows_deleted_at = now(), objects_total = jsonb_array_length(v_objects)
   where user_id = p_user;

  return jsonb_build_object('enqueued', v_total, 'objects', jsonb_array_length(v_objects));
end $$;
```

**`ledger_entries.user_id` and `billing_transactions.user_id` must be nullable and must not cascade** for step 4 to work. Check and alter in the same migration:

```sql
alter table public.ledger_entries alter column user_id drop not null;
alter table public.ledger_entries drop constraint if exists ledger_entries_user_id_fkey;
alter table public.ledger_entries add constraint ledger_entries_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;
alter table public.billing_transactions alter column user_id drop not null;
alter table public.billing_transactions drop constraint if exists billing_transactions_user_id_fkey;
alter table public.billing_transactions add constraint billing_transactions_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;
```

Every query that reads these tables must already filter by `user_id`, so a null is invisible to customers. Verify before relying on it:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "from('ledger_entries')\|from('billing_transactions')\|from public.ledger_entries\|from public.billing_transactions" supabase/functions supabase/migrations | grep -v "user_id" | head -20
```

Expected: no hit that aggregates across users without a filter. Any hit found must be fixed in this task.

- [ ] **Step 2: Add the lapse purge and the outbox claim/complete functions**

Append to the same migration:

```sql
-- ── The lapse purge, with its storage half ────────────────────────────────
/** Day 31 after a paid period ends. The old cron deleted rows with raw SQL and
 * left every object behind; it now routes through the same functions a manual
 * delete uses, so there is exactly one code path that knows how to delete. */
create or replace function public.fn_purge_lapsed()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_id uuid; v_gens int := 0; v_personas int := 0;
begin
  for v_user, v_id in
    select g.user_id, g.id from public.generations g
      join public.subscriptions s on s.user_id = g.user_id
     where s.status in ('canceled','expired')
       and s.current_period_end < now() - interval '30 days'
     limit 5000
  loop
    perform public.fn_delete_generation(v_user, v_id);
    v_gens := v_gens + 1;
  end loop;

  for v_user, v_id in
    select p.user_id, p.id from public.personas p
      join public.subscriptions s on s.user_id = p.user_id
     where s.status in ('canceled','expired')
       and s.current_period_end < now() - interval '30 days'
     limit 5000
  loop
    perform public.fn_delete_persona(v_user, v_id);
    v_personas := v_personas + 1;
  end loop;

  return jsonb_build_object('generations', v_gens, 'personas', v_personas);
end $$;

-- Same name replaces the job (0003, then 0013, now this).
select cron.unschedule(jobid) from cron.job where jobname = 'purge_lapsed_libraries';
select cron.schedule('purge_lapsed_libraries', '0 3 * * *',
  $$ select public.fn_purge_lapsed(); $$);

-- ── Outbox claim / complete / defer ───────────────────────────────────────
create or replace function public.fn_claim_deletions(
  p_worker uuid, p_limit int default 50, p_lease_seconds int default 120
) returns setof public.deletion_outbox
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.deletion_outbox d set
    claimed_by = p_worker,
    claim_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempts = d.attempts + 1
  where d.id in (
    select d2.id from public.deletion_outbox d2
     where d2.run_after <= now()
       and (d2.claim_expires_at is null or d2.claim_expires_at < now())
     order by d2.run_after
     limit p_limit
     for update of d2 skip locked
  )
  returning d.*;
end $$;

/** Done means gone: the row leaves the outbox only when the object is
 * confirmed absent from the backend. */
create or replace function public.fn_complete_deletion(p_id uuid, p_worker uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_hit int; v_user uuid;
begin
  delete from public.deletion_outbox
    where id = p_id and claimed_by = p_worker
    returning user_id into v_user;
  get diagnostics v_hit = row_count;

  update public.account_deletions a set completed_at = now()
   where a.user_id = v_user
     and a.completed_at is null
     and not exists (select 1 from public.deletion_outbox o where o.user_id = a.user_id);
  return v_hit > 0;
end $$;

create or replace function public.fn_defer_deletion(
  p_id uuid, p_worker uuid, p_delay_seconds int, p_error text
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_hit int;
begin
  update public.deletion_outbox set
    run_after = now() + make_interval(secs => p_delay_seconds),
    claimed_by = null, claim_expires_at = null,
    last_error = left(coalesce(p_error, ''), 500)
  where id = p_id and claimed_by = p_worker;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

-- Drive the cleanup worker every 5 minutes. URL + key come from database
-- settings the release runbook sets (P9), never from a migration.
select cron.unschedule(jobid) from cron.job where jobname = 'drive_cleanup_worker';
select cron.schedule('drive_cleanup_worker', '*/5 * * * *', $$
  select net.http_post(
    url := current_setting('app.cleanup_worker_url', true),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)),
    body := '{}'::jsonb)
  where current_setting('app.cleanup_worker_url', true) is not null;
$$);

revoke execute on function public.fn_enqueue_deletions(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.fn_delete_generation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_delete_persona(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_delete_account(uuid) from public, anon, authenticated;
revoke execute on function public.fn_purge_lapsed() from public, anon, authenticated;
revoke execute on function public.fn_claim_deletions(uuid, int, int) from public, anon, authenticated;
revoke execute on function public.fn_complete_deletion(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_defer_deletion(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.fn_enqueue_deletions(uuid, jsonb, text) to service_role;
grant execute on function public.fn_delete_generation(uuid, uuid) to service_role;
grant execute on function public.fn_delete_persona(uuid, uuid) to service_role;
grant execute on function public.fn_delete_account(uuid) to service_role;
grant execute on function public.fn_purge_lapsed() to service_role;
grant execute on function public.fn_claim_deletions(uuid, int, int) to service_role;
grant execute on function public.fn_complete_deletion(uuid, uuid) to service_role;
grant execute on function public.fn_defer_deletion(uuid, uuid, int, text) to service_role;
```

**Note on `fn_delete_account`'s return type.** It changed from `void` to `jsonb`, so Postgres will refuse `create or replace`. Drop it first in the migration:

```sql
drop function if exists public.fn_delete_account(uuid);
```

- [ ] **Step 3: Write the SQL proof**

Create `supabase/tests/deletion.sql`:

```sql
begin;

-- 1. Deleting one generation enqueues both its objects with the right backends.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000001';
  v_gen uuid; v_res jsonb; v_rows int;
begin
  insert into auth.users (id, email) values (v_user, 'del1@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path, thumb_path, storage_backend)
  values (v_user, 'video', 'kling', 'Kling', 'generate', 'v', '{}'::jsonb, 100,
          'done', '', 'u/v.mp4', 'u/v.jpg', 'r2')
  returning id into v_gen;

  v_res := public.fn_delete_generation(v_user, v_gen);
  assert (v_res->>'deleted')::boolean;
  assert (select count(*) from public.generations where id = v_gen) = 0;

  select count(*) into v_rows from public.deletion_outbox where user_id = v_user;
  assert v_rows = 2, format('expected 2 queued objects, got %s', v_rows);
  assert (select backend from public.deletion_outbox where object_path = 'u/v.mp4') = 'r2';
  -- The poster is a client-captured JPEG in Supabase even for an R2 video.
  assert (select backend from public.deletion_outbox where object_path = 'u/v.jpg') = 'supabase';
end $$;

-- 2. Someone else's generation is untouched and reports not-deleted.
do $$
declare
  v_a uuid := 'cccccccc-0000-4000-8000-000000000002';
  v_b uuid := 'cccccccc-0000-4000-8000-000000000003';
  v_gen uuid; v_res jsonb;
begin
  insert into auth.users (id, email) values (v_a, 'own@example.com'), (v_b, 'other@example.com')
    on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_a, '1990-01-01'), (v_b, '1990-01-01')
    on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path)
  values (v_a, 'image', 'flux', 'FLUX', 'generate', 'a', '{}'::jsonb, 40, 'done', '', 'a/1.png')
  returning id into v_gen;

  v_res := public.fn_delete_generation(v_b, v_gen);
  assert not (v_res->>'deleted')::boolean, 'a stranger must not delete it';
  assert (select count(*) from public.generations where id = v_gen) = 1;
  assert (select count(*) from public.deletion_outbox where object_path = 'a/1.png') = 0;
end $$;

-- 3. Persona deletion takes the likeness data with it.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000004';
  v_p uuid; v_rows int;
begin
  insert into auth.users (id, email) values (v_user, 'persona@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.personas (user_id, name, status, photo_paths, lora_path)
    values (v_user, 'Me', 'ready', '["p/1.jpg","p/2.jpg","p/3.jpg"]'::jsonb, 'p/lora.safetensors')
    returning id into v_p;

  perform public.fn_delete_persona(v_user, v_p);
  select count(*) into v_rows from public.deletion_outbox where user_id = v_user;
  assert v_rows = 4, format('3 photos + 1 lora expected, got %s', v_rows);
end $$;

-- 4. THE R11 TEST: account deletion leaves no object behind.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000005';
  v_res jsonb; v_queued int; v_total int;
begin
  insert into auth.users (id, email) values (v_user, 'erase@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path, thumb_path, storage_backend)
  values
    (v_user,'image','flux','FLUX','generate','a','{}'::jsonb,40,'done','','e/1.png',null,'supabase'),
    (v_user,'video','kling','Kling','generate','v','{}'::jsonb,100,'done','','e/2.mp4','e/2.jpg','r2');
  insert into public.personas (user_id, name, status, photo_paths, lora_path)
    values (v_user, 'Me', 'ready', '["e/p1.jpg"]'::jsonb, 'e/lora.safetensors');
  insert into public.uploads (user_id, object_path, byte_size, content_type)
    values (v_user, 'e/ref.png', 1000, 'image/png');
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'cycle_reset', 'plan', 1500, 'seed');

  v_res := public.fn_delete_account(v_user);
  v_total := (v_res->>'objects')::int;
  -- 2 media + 1 poster + 1 photo + 1 lora + 1 upload
  assert v_total = 6, format('expected 6 objects, got %s', v_total);

  assert (select count(*) from public.profiles where id = v_user) = 0;
  select count(*) into v_queued from public.deletion_outbox where user_id = v_user;
  assert v_queued = 6, format('the outbox must survive the cascade, got %s', v_queued);

  -- Money history is kept, detached from the person.
  assert (select count(*) from public.ledger_entries where user_id = v_user) = 0;
  assert (select count(*) from public.ledger_entries where user_id is null and note = 'seed') = 1;
end $$;

-- 5. Deleting an account twice finishes the job instead of failing.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000006';
  v_first jsonb; v_second jsonb;
begin
  insert into auth.users (id, email) values (v_user, 'twice@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path)
  values (v_user,'image','flux','FLUX','generate','a','{}'::jsonb,40,'done','','t/1.png');
  v_first := public.fn_delete_account(v_user);
  v_second := public.fn_delete_account(v_user);
  assert (v_first->>'objects')::int = 1;
  assert (v_second->>'objects')::int = 0, 'the second run has nothing left to find';
  assert (select count(*) from public.deletion_outbox where object_path = 't/1.png') = 1,
         'and it must not double-enqueue';
end $$;

-- 6. The lapse purge deletes rows AND enqueues their objects.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000007';
  v_res jsonb;
begin
  insert into auth.users (id, email) values (v_user, 'lapsed@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
    values (v_user, 'studio', 'canceled', now() - interval '31 days');
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path)
  values (v_user,'image','flux','FLUX','generate','a','{}'::jsonb,40,'done','','l/1.png');

  v_res := public.fn_purge_lapsed();
  assert (v_res->>'generations')::int >= 1;
  assert (select count(*) from public.generations where user_id = v_user) = 0;
  assert (select count(*) from public.deletion_outbox where object_path = 'l/1.png') = 1,
         'the lapse purge must not leave orphans either';
end $$;

-- 7. A still-paid subscriber is never purged.
do $$
declare v_user uuid := 'cccccccc-0000-4000-8000-000000000008';
begin
  insert into auth.users (id, email) values (v_user, 'paid@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
    values (v_user, 'studio', 'active', now() + interval '20 days');
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings, price_credits,
     status, media_url, media_path)
  values (v_user,'image','flux','FLUX','generate','a','{}'::jsonb,40,'done','','k/1.png');
  perform public.fn_purge_lapsed();
  assert (select count(*) from public.generations where user_id = v_user) = 1,
         'an active subscriber must keep their library';
end $$;

-- 8. Two cleanup workers never claim the same object.
do $$
declare v_a int; v_b int;
begin
  insert into public.deletion_outbox (user_id, backend, object_path, reason)
    values (null, 'supabase', 'race/1.png', 'test');
  select count(*) into v_a from public.fn_claim_deletions(gen_random_uuid(), 50, 120);
  select count(*) into v_b from public.fn_claim_deletions(gen_random_uuid(), 50, 120);
  assert v_b = 0, format('second worker claimed %s rows', v_b);
end $$;

-- 9. A stale claim cannot complete over the worker that took over.
do $$
declare v_id uuid; v_old uuid := gen_random_uuid(); v_new uuid := gen_random_uuid(); v_ok boolean;
begin
  insert into public.deletion_outbox (user_id, backend, object_path, reason)
    values (null, 'r2', 'stale/1.mp4', 'test') returning id into v_id;
  perform public.fn_claim_deletions(v_old, 1, 120);
  update public.deletion_outbox set claim_expires_at = now() - interval '1 minute' where id = v_id;
  perform public.fn_claim_deletions(v_new, 1, 120);
  v_ok := public.fn_complete_deletion(v_id, v_old);
  assert not v_ok, 'the stale claim must not remove the row';
  assert (select count(*) from public.deletion_outbox where id = v_id) = 1;
end $$;

rollback;
```

- [ ] **Step 4: Apply and run**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0021_durable_deletion.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/deletion.sql
```

Expected: nine `DO` lines and `ROLLBACK`, no assertion failure. User commits.

---

## Task 3: The deletion service and cleanup worker

**Files:**
- Create: `supabase/functions/_shared/storage/deletion-service.ts` + `_test.ts`
- Create: `supabase/functions/cleanup-worker/index.ts`, `handler.ts`, `handler_test.ts`, `deno.json`; symlink `_shared`

**Interfaces:**
- Produces:
  ```ts
  export type DeleteOutcome = 'gone' | 'retry';
  export function deleteObject(storageFor, backend, path): Promise<DeleteOutcome>;
  export function createCleanupWorker(deps): (req: Request) => Promise<Response>;
  ```

**The rule this service encodes:** an object that is **already absent** is a success, not a failure. A 404 from the backend means the bytes are gone, which is exactly what was asked for. Treating it as an error is how an outbox row retries forever.

- [ ] **Step 1: Write the failing service test**

Create `supabase/functions/_shared/storage/deletion_service_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { deleteObject } from './deletion-service.ts';

function backendThat(fn: (path: string) => Promise<void>) {
  return () => ({ put: () => Promise.resolve(), delete: fn }) as never;
}

Deno.test('a successful delete is gone', async () => {
  const seen: string[] = [];
  const outcome = await deleteObject(
    backendThat((p) => {
      seen.push(p);
      return Promise.resolve();
    }),
    'supabase',
    'u/1.png',
  );
  assertEquals(outcome, 'gone');
  assertEquals(seen, ['u/1.png']);
});

Deno.test('an object that is already absent is gone, not an error', async () => {
  for (const message of ['404 Not Found', 'NoSuchKey', 'Object not found', 'The specified key does not exist']) {
    const outcome = await deleteObject(
      backendThat(() => Promise.reject(new Error(message))),
      'r2',
      'u/1.mp4',
    );
    assertEquals(outcome, 'gone', `"${message}" means the bytes are gone`);
  }
});

Deno.test('a transport failure retries', async () => {
  const outcome = await deleteObject(
    backendThat(() => Promise.reject(new Error('503 Service Unavailable'))),
    'r2',
    'u/1.mp4',
  );
  assertEquals(outcome, 'retry');
});

Deno.test('a permission failure retries rather than dropping the object', async () => {
  // 403 usually means a misconfigured key, which is fixable. Silently
  // completing here would leave the customer's bytes in the bucket forever
  // with nothing left to point at them.
  const outcome = await deleteObject(
    backendThat(() => Promise.reject(new Error('403 Forbidden'))),
    'r2',
    'u/1.mp4',
  );
  assertEquals(outcome, 'retry');
});

Deno.test('an unknown backend retries rather than claiming success', async () => {
  const outcome = await deleteObject(
    () => {
      throw new Error('unknown backend');
    },
    'nonsense' as never,
    'u/1.png',
  );
  assertEquals(outcome, 'retry');
});
```

- [ ] **Step 2: Run to verify it fails, then write the service**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/storage/deletion_service_test.ts
```

Expected: FAIL — module not found. Then create `supabase/functions/_shared/storage/deletion-service.ts`:

```ts
// Deleting bytes, with the one distinction that matters: "already absent" is
// success. A 404 means the object is gone, which is what was asked for.
// Treating it as a failure makes an outbox row retry until the end of time.
import type { StorageAdapter, StorageBackend } from './index.ts';

export type DeleteOutcome = 'gone' | 'retry';

const ABSENT = [
  '404',
  'not found',
  'nosuchkey',
  'does not exist',
  'no such file',
];

function meansAbsent(e: unknown): boolean {
  const message = String(e instanceof Error ? e.message : e).toLowerCase();
  return ABSENT.some((needle) => message.includes(needle));
}

export async function deleteObject(
  storageFor: (backend: StorageBackend) => StorageAdapter,
  backend: StorageBackend,
  path: string,
): Promise<DeleteOutcome> {
  try {
    await storageFor(backend).delete(path);
    return 'gone';
  } catch (e) {
    if (meansAbsent(e)) return 'gone';
    // Everything else — transport, throttling, a bad key — is fixable, so the
    // row stays in the outbox and we try again.
    console.error('delete_failed', backend, path, String(e).slice(0, 200));
    return 'retry';
  }
}
```

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/storage/deletion_service_test.ts
```

Expected: `5 passed | 0 failed`.

- [ ] **Step 3: Create the worker directory and write its failing test**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && mkdir -p cleanup-worker && ln -s ../_shared cleanup-worker/_shared && cp job-worker/deno.json cleanup-worker/deno.json && ls -la cleanup-worker/
```

Create `supabase/functions/cleanup-worker/handler_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb } from './_shared/testing/fakes.ts';
import { createCleanupWorker } from './handler.ts';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'd1', user_id: null, backend: 'supabase', object_path: 'u/1.png',
    reason: 'account_deleted', attempts: 1, ...over,
  };
}

function db(rows: Record<string, unknown>[]): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_claim_deletions = () => rows;
  d.rpcHandlers.fn_complete_deletion = (_a, self) => {
    self.tables.completed ??= [];
    self.tables.completed.push(_a);
    return true;
  };
  d.rpcHandlers.fn_defer_deletion = (_a, self) => {
    self.tables.deferred ??= [];
    self.tables.deferred.push(_a);
    return true;
  };
  return d;
}

function deps(d: FakeDb, del: (p: string) => Promise<void>) {
  return {
    admin: d as never,
    storageFor: () => ({ put: () => Promise.resolve(), delete: del }) as never,
    workerId: 'cleanup-1',
  };
}

Deno.test('a deleted object leaves the outbox', async () => {
  const d = db([row()]);
  const res = await createCleanupWorker(deps(d, () => Promise.resolve()))(
    new Request('https://x/', { method: 'POST' }),
  );
  assertEquals((await res.json()).deleted, 1);
  assertEquals(d.tables.completed.length, 1);
  assertEquals(d.tables.deferred ?? [], []);
});

Deno.test('an object that is already gone also leaves the outbox', async () => {
  const d = db([row()]);
  await createCleanupWorker(deps(d, () => Promise.reject(new Error('404 Not Found'))))(
    new Request('https://x/', { method: 'POST' }),
  );
  assertEquals(d.tables.completed.length, 1);
});

Deno.test('a failing delete is deferred with growing backoff, never dropped', async () => {
  const d = db([row({ attempts: 3 })]);
  await createCleanupWorker(deps(d, () => Promise.reject(new Error('503 down'))))(
    new Request('https://x/', { method: 'POST' }),
  );
  assertEquals(d.tables.completed ?? [], []);
  assertEquals(d.tables.deferred.length, 1);
  assertEquals(d.tables.deferred[0].p_delay_seconds > 0, true);
});

Deno.test('one failing object does not stop the batch', async () => {
  const d = db([row({ id: 'd1', object_path: 'bad.png' }), row({ id: 'd2', object_path: 'good.png' })]);
  await createCleanupWorker(
    deps(d, (p) => (p === 'bad.png' ? Promise.reject(new Error('503')) : Promise.resolve())),
  )(new Request('https://x/', { method: 'POST' }));
  assertEquals(d.tables.completed.length, 1);
  assertEquals(d.tables.deferred.length, 1);
});

Deno.test('both backends are used, each for its own rows', async () => {
  const d = db([row({ id: 'd1', backend: 'supabase' }), row({ id: 'd2', backend: 'r2', object_path: 'u/1.mp4' })]);
  const asked: string[] = [];
  const worker = createCleanupWorker({
    admin: d as never,
    storageFor: (backend: string) => ({
      put: () => Promise.resolve(),
      delete: (p: string) => {
        asked.push(`${backend}:${p}`);
        return Promise.resolve();
      },
    }) as never,
    workerId: 'cleanup-1',
  });
  await worker(new Request('https://x/', { method: 'POST' }));
  assertEquals(asked.sort(), ['r2:u/1.mp4', 'supabase:u/1.png']);
});

Deno.test('an empty outbox is a fast no-op', async () => {
  const d = db([]);
  const res = await createCleanupWorker(deps(d, () => Promise.reject(new Error('should not be called'))))(
    new Request('https://x/', { method: 'POST' }),
  );
  assertEquals((await res.json()).deleted, 0);
});

Deno.test('a GET is refused', async () => {
  const res = await createCleanupWorker(deps(db([]), () => Promise.resolve()))(new Request('https://x/'));
  assertEquals(res.status, 405);
});
```

- [ ] **Step 4: Run to verify it fails, then write the worker**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all cleanup-worker/handler_test.ts
```

Expected: FAIL — module not found. Then create `supabase/functions/cleanup-worker/handler.ts`:

```ts
// Drains the deletion outbox.
//
// The slow, failure-prone half of a delete lives here so the customer's
// request never waits on a storage provider and never silently loses the work
// when one is having a bad minute.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { deleteObject } from './_shared/storage/deletion-service.ts';
import type { StorageAdapter, StorageBackend } from './_shared/storage/index.ts';

export interface CleanupDeps {
  admin: SupabaseClient;
  storageFor(backend: StorageBackend): StorageAdapter;
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
}

const BASE_BACKOFF_S = 60;
const MAX_BACKOFF_S = 3600;

function backoffSeconds(attempts: number): number {
  return Math.min(BASE_BACKOFF_S * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_S);
}

export function createCleanupWorker(deps: CleanupDeps): (req: Request) => Promise<Response> {
  const batchSize = deps.batchSize ?? 50;
  const leaseSeconds = deps.leaseSeconds ?? 120;

  return async function serve(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const { data, error } = await deps.admin.rpc('fn_claim_deletions', {
      p_worker: deps.workerId,
      p_limit: batchSize,
      p_lease_seconds: leaseSeconds,
    });
    if (error) {
      console.error('claim_deletions_failed', error.message);
      return Response.json({ deleted: 0, deferred: 0, error: 'claim_failed' }, { status: 200 });
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    let deleted = 0;
    let deferred = 0;

    for (const row of rows) {
      const backend = String(row.backend) as StorageBackend;
      const path = String(row.object_path);
      const outcome = await deleteObject(deps.storageFor, backend, path);

      if (outcome === 'gone') {
        await deps.admin.rpc('fn_complete_deletion', { p_id: row.id, p_worker: deps.workerId });
        deleted += 1;
        continue;
      }

      // Never dropped. A row that keeps failing keeps its error and gets
      // alerted on (P9) rather than quietly disappearing with the bytes.
      await deps.admin.rpc('fn_defer_deletion', {
        p_id: row.id,
        p_worker: deps.workerId,
        p_delay_seconds: backoffSeconds(Number(row.attempts ?? 1)),
        p_error: 'delete_failed',
      });
      deferred += 1;
    }

    return Response.json({ claimed: rows.length, deleted, deferred });
  };
}
```

Create `supabase/functions/cleanup-worker/index.ts`:

```ts
// Production composition for the cleanup worker. Behaviour lives in handler.ts.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { storageFor } from './_shared/storage/index.ts';
import { createCleanupWorker } from './handler.ts';

Deno.serve(createCleanupWorker({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  storageFor,
  workerId: crypto.randomUUID(),
  batchSize: Number(Deno.env.get('CLEANUP_BATCH') ?? 50),
}));
```

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check cleanup-worker/index.ts && deno test --allow-all cleanup-worker _shared/storage
```

Expected: `12 passed | 0 failed`. User commits.

---

## Task 4: Route every delete through the new path

**Files:**
- Modify: `supabase/functions/api/app.ts`
- Create: `supabase/functions/api/deletion_routes_test.ts`

- [ ] **Step 1: Write the failing route test**

Create `supabase/functions/api/deletion_routes_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

Deno.test('R11: deleting a generation goes through the transactional path', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_delete_generation = () => ({ deleted: true, objects: 2 });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1', { method: 'DELETE', headers: AUTH });

  assertEquals(res.status, 200);
  const call = db.rpcCalls.find((r) => r.name === 'fn_delete_generation')!;
  assertEquals(call.args.p_user, TEST_USER);
  assertEquals(call.args.p_generation, 'g1');
});

Deno.test('a missing generation is 404 and enqueues nothing', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_delete_generation = () => ({ deleted: false });
  const app = createApp(deps);
  const res = await app.request('/api/generations/nope', { method: 'DELETE', headers: AUTH });
  assertEquals(res.status, 404);
});

Deno.test('the route never deletes storage itself — that is the worker\'s job', async () => {
  let storageCalls = 0;
  const deps = testDeps({
    storageFor: () => ({
      put: () => Promise.resolve(),
      delete: () => {
        storageCalls += 1;
        return Promise.resolve();
      },
    }) as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_delete_generation = () => ({ deleted: true, objects: 1 });
  const app = createApp(deps);
  await app.request('/api/generations/g1', { method: 'DELETE', headers: AUTH });
  assertEquals(storageCalls, 0, 'a storage hiccup must not be able to fail this request');
});

Deno.test('deleting a PENDING generation cancels its job first', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = [{ id: 'g1', user_id: TEST_USER, status: 'pending', media_path: null }];
  db.tables.jobs = [{ id: 'j1', generation_id: 'g1', user_id: TEST_USER, provider_ref: 'req_1', state: 'submitted' }];
  db.rpcHandlers.fn_delete_generation = () => ({ deleted: true, objects: 0 });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1', { method: 'DELETE', headers: AUTH });

  assertEquals(res.status, 200);
  // Otherwise the worker settles a row that is no longer there.
  assertEquals(db.tables.jobs[0].state, 'done');
});

Deno.test('R11: deleting a persona goes through the transactional path', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_delete_persona = () => ({ deleted: true, objects: 4 });
  const app = createApp(deps);
  const res = await app.request('/api/personas/p1', { method: 'DELETE', headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_delete_persona'), true);
});

Deno.test('R11: account deletion reports how many objects it queued', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.profiles = [{ id: TEST_USER, stripe_customer_id: null }];
  db.rpcHandlers.fn_delete_account = () => ({ enqueued: 6, objects: 6 });
  const app = createApp(deps);

  const res = await app.request('/api/profile', { method: 'DELETE', headers: AUTH });

  assertEquals(res.status, 200);
  assertEquals((await res.json()).objectsQueued, 6);
});

Deno.test('a failed Stripe cancel aborts the delete before any row is touched', async () => {
  const deps = testDeps({
    stripe: {
      subscriptions: {
        list: () => Promise.reject(new Error('stripe down')),
        cancel: () => Promise.resolve({}),
      },
    } as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.profiles = [{ id: TEST_USER, stripe_customer_id: 'cus_1' }];
  const app = createApp(deps);

  const res = await app.request('/api/profile', { method: 'DELETE', headers: AUTH });

  assertEquals(res.status, 400);
  // Deleting the rows while a live subscription keeps billing would charge a
  // customer who no longer has an account.
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_delete_account'), false);
});

Deno.test('a failed auth-user delete is reported, not swallowed', async () => {
  const deps = testDeps({
    authAdmin: { deleteUser: () => Promise.resolve({ error: { message: 'auth down' } }) } as never,
  });
  const db = deps.admin as unknown as FakeDb;
  db.tables.profiles = [{ id: TEST_USER, stripe_customer_id: null }];
  db.rpcHandlers.fn_delete_account = () => ({ enqueued: 1, objects: 1 });
  const app = createApp(deps);
  const res = await app.request('/api/profile', { method: 'DELETE', headers: AUTH });
  assertEquals(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails, then rewrite the routes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/deletion_routes_test.ts
```

Expected: FAIL — the routes still delete rows and objects inline.

Replace `DELETE /generations/:id` in `app.ts`:

```ts
app.delete('/generations/:id', async (c) => {
  const userId = c.get('userId') as string;
  const id = c.req.param('id');

  // A pending generation still has a worker holding a job for it. Cancel first
  // or the worker settles a row that no longer exists.
  await cancelJobForGeneration(userId, id);

  // The row and the intent to delete its bytes commit together, so a storage
  // outage can no longer produce an object nothing can name.
  const { data, error } = await admin.rpc('fn_delete_generation', {
    p_user: userId,
    p_generation: id,
  });
  if (error) return fail(c, 400, 'delete_failed', error.message);

  const result = data as { deleted: boolean; objects?: number };
  if (!result.deleted) return fail(c, 404, 'not_found', 'Generation not found.');
  return c.json({ ok: true, objectsQueued: result.objects ?? 0 });
});
```

Add the helper inside `createApp`:

```ts
/** Best-effort provider cancel plus a hard local stop, so the worker will not
 * pick the job up again after its generation is gone. */
async function cancelJobForGeneration(userId: string, generationId: string): Promise<void> {
  const { data: job } = await admin
    .from('jobs')
    .select('id,provider,provider_ref,state')
    .eq('user_id', userId)
    .eq('generation_id', generationId)
    .maybeSingle();
  if (!job) return;
  if (job.provider_ref) {
    await adapterFor(job.provider).cancel?.(job.provider_ref).catch(() => undefined);
  }
  await admin.from('jobs').update({ state: 'done', run_after: FAR_FUTURE }).eq('id', job.id);
}
```

Replace `DELETE /personas/:id` the same way, calling `fn_delete_persona`, and delete whatever inline photo cleanup exists there today.

Replace the tail of `deleteAccount`:

```ts
  // Cancel billing FIRST. Removing the rows while a subscription keeps
  // renewing would charge a customer who no longer has an account.
  // (the existing Stripe block above stays exactly as it is)

  const { data, error } = await admin.rpc('fn_delete_account', { p_user: userId });
  if (error) return fail(c, 400, 'delete_failed', error.message);

  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) {
    // The rows are gone and the objects are queued; only the auth row remains.
    // Saying "ok" here would hide a half-finished erasure.
    logError(c, 'delete_auth_failed', authError);
    return fail(c, 400, 'delete_failed', authError.message);
  }
  ageOkMemo.delete(userId);
  deletedObjects = (data as { objects?: number })?.objects ?? 0;
  return null;
```

`deleteAccount` currently returns `Response | null`; give the caller the count by returning `{ error: Response | null; objectsQueued: number }`, and have `DELETE /profile` answer `c.json({ ok: true, objectsQueued })`.

- [ ] **Step 3: Make `/library/import` and `/edits/save` enqueue instead of orphaning**

`/library/import` deletes the generation row when the upload fails but leaves any partial object. Route its cleanup through `fn_enqueue_deletions` too:

```ts
  if (upErr) {
    await admin.from('generations').delete().eq('id', gen.id);
    // The upload may have landed partially; queue the path either way. An
    // already-absent object completes on the first attempt.
    await admin.rpc('fn_enqueue_deletions', {
      p_user: userId,
      p_objects: [{ backend: 'supabase', path }],
      p_reason: 'import_failed',
    });
    return fail(c, 400, 'save_failed', 'Storage rejected the file');
  }
```

Apply the same to P4's `dropLostObject` so there is exactly one mechanism that deletes bytes.

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "storage.from('media').remove\|storageFor(.*).delete(" supabase/functions/api supabase/functions/_shared | grep -v deletion-service
```

Expected: no hit outside `deletion-service.ts`. Every remaining hit is a path that can still orphan.

- [ ] **Step 4: Run the suites**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook
```

Expected: all green. User commits.

---

## Task 5: Prove it — the inventory reconciler

**Files:**
- Create: `scripts/storage-inventory.mjs`
- Create: `docs/superpowers/plans/2026-09-20-deletion-verification-log.md`

**This script is read-only.** It reports; it never deletes. A reconciler that deletes is a reconciler that can delete the wrong thing at four in the morning.

- [ ] **Step 1: Write the reconciler**

Create `scripts/storage-inventory.mjs`:

```js
#!/usr/bin/env node
// Read-only reconciliation between storage and the database.
//
// Two questions, both of which had no answer before this:
//   ORPHANS — objects in a bucket that no row references. Someone's deleted
//             data still sitting there.
//   LEAKS   — rows pointing at objects that are not in the bucket. Broken
//             images for a paying customer.
//
// It prints. It never deletes. Removing anything is a human decision made
// after reading this report.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}
const db = createClient(url, key);

async function referencedPaths() {
  const paths = new Set();
  for (const [table, columns] of [
    ['generations', ['media_path', 'thumb_path']],
    ['uploads', ['object_path']],
  ]) {
    let from = 0;
    for (;;) {
      const { data, error } = await db.from(table).select(columns.join(',')).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const row of data ?? []) {
        for (const col of columns) {
          if (row[col]) paths.add(row[col]);
        }
      }
      if ((data ?? []).length < 1000) break;
      from += 1000;
    }
  }
  const { data: personas } = await db.from('personas').select('photo_paths,lora_path');
  for (const p of personas ?? []) {
    for (const photo of p.photo_paths ?? []) paths.add(photo);
    if (p.lora_path) paths.add(p.lora_path);
  }
  return paths;
}

async function bucketPaths(bucket, prefix = '', acc = []) {
  const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
  for (const entry of data ?? []) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      await bucketPaths(bucket, full, acc);
      continue;
    }
    acc.push(full);
  }
  return acc;
}

const referenced = await referencedPaths();
const stored = await bucketPaths('media');
const { data: queued } = await db.from('deletion_outbox').select('object_path');
const pending = new Set((queued ?? []).map((r) => r.object_path));

// An object already queued for deletion is not an orphan; it is in progress.
const orphans = stored.filter((p) => !referenced.has(p) && !pending.has(p));
const leaks = [...referenced].filter((p) => !stored.includes(p));

console.log(`referenced rows : ${referenced.size}`);
console.log(`stored objects  : ${stored.length}`);
console.log(`queued to delete: ${pending.size}`);
console.log(`ORPHANS         : ${orphans.length}`);
console.log(`LEAKS           : ${leaks.length}`);
for (const p of orphans.slice(0, 50)) console.log(`  orphan ${p}`);
for (const p of leaks.slice(0, 50)) console.log(`  leak   ${p}`);

process.exit(orphans.length + leaks.length > 0 ? 1 : 0);
```

**R2 is not covered by `storage.from().list()`.** Add a second pass using the S3-compatible list from `_shared/storage/r2.ts`, or note in the report header that R2 is reconciled separately. Do not let the script print a clean bill of health for storage it never looked at.

- [ ] **Step 2: Run it against the local stack**

```bash
cd /Users/user/IdeaProjects/vansen && SUPABASE_URL="$VANSEN_LOCAL_URL" SUPABASE_SERVICE_ROLE_KEY="$VANSEN_LOCAL_SERVICE_KEY" node scripts/storage-inventory.mjs
```

Expected on a clean local stack: `ORPHANS : 0` and `LEAKS : 0`, exit 0.

- [ ] **Step 3: Rehearse deletion end to end and record it**

Create `docs/superpowers/plans/2026-09-20-deletion-verification-log.md` recording each scenario against the local stack, with the inventory output before and after:

| Scenario | Expected |
|---|---|
| Delete one image | Row gone, object gone after one worker tick, inventory clean |
| Delete a video in R2 with a Supabase poster | Both objects gone, each from its own backend |
| Delete a pending generation | Job cancelled, no settlement afterwards, no orphan |
| Delete a persona | Photos and LoRA gone; likeness data does not survive |
| Delete an account with images, a video, a persona and an upload | Every object gone; ledger rows remain with `user_id` null |
| Delete the same account twice | Second call is a no-op and does not double-enqueue |
| Storage returns 503 for every delete | Nothing is dropped; rows stay queued with a growing `run_after` |
| Storage returns 404 | Row completes on the first attempt |
| Lapse purge on a 31-day-lapsed user | Rows and objects both gone |
| Lapse purge on an active subscriber | Nothing touched |
| Kill the cleanup worker mid-batch | Claims expire, next tick finishes, no object left behind |

- [ ] **Step 4: Fix the customer-facing copy to match**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "delete\|remove" src/app/features/settings --include=*.html | head -20
```

Update the delete-account dialog to state what Task 1's policy actually decided, including that financial records are kept in anonymised form and how long removal takes. Do not promise "immediately and permanently" if the outbox can take minutes; say what is true.

- [ ] **Step 5: Final run**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/deletion.sql
```

Expected: all green. User commits.

---

## Exit criteria for P6

- [ ] Deleting an account removes every object it owned from both backends, proven by the inventory script reporting zero orphans afterwards.
- [ ] The ledger survives account deletion with `user_id` null, and no customer-facing query can see those rows.
- [ ] Deleting a generation, a persona or a whole account never leaves an object unreferenced, even when storage fails — the work stays queued and retries.
- [ ] A storage outage cannot fail a customer's delete request.
- [ ] Deleting a pending generation cancels its job, and the worker never settles a row that is gone.
- [ ] The lapse purge deletes objects, not just rows.
- [ ] An already-absent object completes on the first attempt instead of retrying forever.
- [ ] Two cleanup workers never claim the same object, and a stale claim cannot complete over a takeover.
- [ ] Exactly one code path deletes bytes: `deletion-service.ts`, driven by the outbox. No inline `storage.remove` remains.
- [ ] The retention policy is written down, its numbers are enforced by the migration, and the settings copy matches it.

**Known carry-forward:** the `cleanup-worker` function is written and tested but **not deployed**, and `app.cleanup_worker_url` is not set; P9 does both and adds the alert for outbox rows stuck past their retry budget.
