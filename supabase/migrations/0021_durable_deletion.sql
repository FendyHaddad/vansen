-- 0021: durable deletion (P6 / T08, closing R11 and decision D2).
--
-- Before this file, "delete" meant: drop the rows and hope about the bytes.
-- `fn_delete_account` was one statement — `delete from profiles` — and the
-- cascade took the rows that named every object the customer ever made, which
-- left the objects themselves unreachable forever. The lapse purge did the
-- same. `DELETE /generations/:id` deleted the row first and then swallowed any
-- storage error.
--
-- Deletion is now a lifecycle with a paper trail:
--
--   storage_objects            every byte we hold, with its backend AND bucket
--   deletion_outbox            what must be removed, leased and retried
--   provider_artifact_deletions  what someone ELSE holds for us
--   account_deletions          the audit record of a closure
--
-- Rules this file enforces, in order of how much money they protect:
--   * A row is never dropped while its object is still unaccounted for: the
--     outbox insert and the row removal happen in ONE transaction.
--   * A storage failure never blocks a customer's delete. It becomes a retry.
--   * Pending work is tombstoned and cancelled, never cascaded away mid-flight.
--   * Financial history and approved evidence survive closure, anonymised.
--
-- Policy numbers come from docs/superpowers/specs/2026-09-20-retention-policy.md
-- (decision D2, decided 2026-09-21). Changing one means changing that file,
-- this one and supabase/tests/deletion.sql together.
--
-- (written 2026-09-21; apply AFTER 0020_durable_dispatch.sql)

do $$
begin
  if to_regclass('public.jobs') is null or to_regclass('public.submissions') is null then
    raise exception '0021 requires 0020_durable_dispatch.sql (jobs + submissions) first';
  end if;
  if to_regclass('public.uploads') is null then
    raise exception '0021 requires 0017_upload_registry.sql (uploads) first';
  end if;
end $$;

-- ------------------------------------------------------------------ config
--
-- The R2 bucket name lives in an Edge Function secret, so the database cannot
-- know it. It is recorded here once at rollout; anything that needs it asks
-- and gets a loud error rather than a guess. A guessed bucket is a delete
-- aimed at the wrong store.
create table if not exists public.storage_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.storage_config enable row level security;

create or replace function public.fn_storage_config(p_key text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select value into v from public.storage_config where key = p_key;
  if v is null or v = '' then
    raise exception 'storage_config % is not set', p_key using errcode = 'P0001';
  end if;
  return v;
end $$;

-- --------------------------------------------------------------- registry

create table if not exists public.storage_objects (
  id uuid primary key default gen_random_uuid(),
  -- Nulled when the account is finalised: the audit row outlives its owner.
  user_id uuid references public.profiles on delete set null,
  backend text not null check (backend in ('supabase','r2')),
  bucket text not null,
  path text not null,
  purpose text not null check (purpose in (
    'media','thumb','upload','persona-photo','persona-zip','scratch','quarantine'
  )),
  -- staged        intent recorded, the write may or may not have landed
  -- live          referenced by a row a customer can see
  -- delete_pending queued for removal; the outbox owns it now
  -- held          kept on purpose (evidence), with a deadline
  -- gone          removal confirmed against the exact backend/bucket/key
  state text not null default 'staged'
    check (state in ('staged','live','delete_pending','held','gone')),
  retain_until timestamptz,
  created_at timestamptz not null default now(),
  unique (backend, bucket, path)
);
alter table public.storage_objects enable row level security;
create index if not exists storage_objects_user_idx on public.storage_objects (user_id);
create index if not exists storage_objects_state_idx on public.storage_objects (state);
create index if not exists storage_objects_hold_idx on public.storage_objects (retain_until)
  where state = 'held';

create table if not exists public.deletion_outbox (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null references public.storage_objects(id) on delete cascade,
  -- Copied from the registry, never from a caller: the locator has to survive
  -- the row that referenced it.
  backend text not null,
  bucket text not null,
  object_path text not null,
  reason text not null,
  not_before timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (backend, bucket, object_path)
);
alter table public.deletion_outbox enable row level security;
create index if not exists deletion_outbox_due_idx on public.deletion_outbox (not_before)
  where completed_at is null;

create table if not exists public.provider_artifact_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete set null,
  provider text not null check (provider in ('google','openai','fal','runway')),
  artifact_ref text not null,
  -- 'unsupported' is an honest terminal state: the provider offers no deletion
  -- API. It is reported to the customer as a limitation, never as removal.
  status text not null check (status in ('requested','processing','confirmed','unsupported','failed')),
  evidence_ref text,
  last_error text,
  -- Set when the owner is anonymised: the artifact still has to be chased,
  -- and the closure it belongs to still has to be able to report it.
  deletion_ref uuid,
  next_run_at timestamptz default now(),
  created_at timestamptz not null default now(),
  unique (provider, artifact_ref)
);
alter table public.provider_artifact_deletions enable row level security;
create index if not exists provider_artifact_due_idx on public.provider_artifact_deletions (next_run_at)
  where status in ('requested','processing','failed');

create table if not exists public.account_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete set null,
  -- Kept after the profile row is gone so the auth user can still be removed
  -- and the audit trail still resolves. Cleared at completion.
  auth_user_id uuid,
  status text not null default 'requested'
    check (status in ('requested','processing','completed')),
  subscriptions jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  data_finalized_at timestamptz,
  auth_deleted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.account_deletions enable row level security;
create unique index if not exists one_open_account_deletion
  on public.account_deletions (user_id) where status <> 'completed';

alter table public.provider_artifact_deletions
  add column if not exists deletion_ref uuid references public.account_deletions on delete set null;

-- --------------------------------------------------------------- tombstones

alter table public.generations add column if not exists deleted_at timestamptz;
alter table public.personas add column if not exists deleted_at timestamptz;
alter table public.profiles add column if not exists deletion_requested_at timestamptz;
create index if not exists generations_deleted_idx on public.generations (deleted_at)
  where deleted_at is not null;
create index if not exists personas_deleted_idx on public.personas (deleted_at)
  where deleted_at is not null;

-- ------------------------------------------------- anonymisation prerequisites
--
-- D2 keeps financial history and moderation evidence after closure. They
-- currently cascade from `profiles`, which would delete exactly the rows a
-- chargeback or an appeal needs. Each one loses its NOT NULL and its cascade,
-- and gains a non-identifying reference to the closure that anonymised it.

do $$
declare
  t text;
begin
  foreach t in array array[
    'ledger_entries','billing_transactions','moderation_events',
    'provider_expenses','training_provider_expenses','billing_deliveries'
  ] loop
    execute format('alter table public.%I alter column user_id drop not null', t);
    execute format(
      'alter table public.%I add column if not exists deletion_ref uuid references public.account_deletions on delete set null',
      t);
  end loop;
end $$;

-- Re-point the cascading foreign keys at "set null". Constraint names follow
-- the default <table>_<column>_fkey; a table whose FK is missing (billing_
-- deliveries never had one) is simply skipped.
do $$
declare
  r record;
begin
  for r in
    select c.conname, t.relname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and c.contype = 'f'
       and c.confdeltype = 'c'
       and t.relname in ('ledger_entries','billing_transactions','moderation_events',
                         'provider_expenses','training_provider_expenses')
       and (select attname from pg_attribute
             where attrelid = c.conrelid and attnum = c.conkey[1]) = 'user_id'
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (user_id) references public.profiles(id) on delete set null',
      r.relname, r.conname);
  end loop;
end $$;

-- The expense tables keyed themselves on the job id and cascaded from it, and
-- `jobs` cascades from `profiles` — so closing an account would have deleted
-- the cost history D2 keeps. Give each one its own key and let the job
-- reference fall away instead.
do $$
declare
  r record;
  t text;
begin
  foreach t in array array['provider_expenses','training_provider_expenses'] loop
    execute format('alter table public.%I add column if not exists id uuid not null default gen_random_uuid()', t);
    for r in
      select c.conname from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and cl.relname = t and c.contype = 'p'
    loop
      execute format('alter table public.%I drop constraint %I', t, r.conname);
    end loop;
    execute format('alter table public.%I add primary key (id)', t);
    execute format('alter table public.%I alter column job_id drop not null', t);
    execute format('create unique index if not exists %I on public.%I (job_id)', t || '_job_key', t);
    for r in
      select c.conname from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and cl.relname = t and c.contype = 'f'
         and c.confdeltype = 'c'
         and (select attname from pg_attribute
               where attrelid = c.conrelid and attnum = c.conkey[1]) = 'job_id'
    loop
      execute format('alter table public.%I drop constraint %I', t, r.conname);
    end loop;
  end loop;
end $$;

alter table public.provider_expenses drop constraint if exists provider_expenses_job_id_fkey;
alter table public.provider_expenses
  add constraint provider_expenses_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete set null;
alter table public.training_provider_expenses drop constraint if exists training_provider_expenses_job_id_fkey;
alter table public.training_provider_expenses
  add constraint training_provider_expenses_job_id_fkey
  foreign key (job_id) references public.training_jobs(id) on delete set null;

-- ------------------------------------------------------- registry writers
--
-- Intent is recorded BEFORE the bytes are written. A write whose response we
-- never saw still leaves a locator behind, which is the difference between an
-- orphan we can find and an orphan we cannot.

create or replace function public.fn_register_object(
  p_user uuid, p_backend text, p_bucket text, p_path text, p_purpose text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(p_bucket, '') = '' or coalesce(p_path, '') = '' then
    raise exception 'invalid_object_locator' using errcode = 'P0001';
  end if;
  insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
  values (p_user, p_backend, p_bucket, p_path, p_purpose, 'staged')
  on conflict (backend, bucket, path) do update
    set user_id = coalesce(public.storage_objects.user_id, excluded.user_id)
  returning id into v_id;
  return v_id;
end $$;

/** The write landed. Only a staged object may be promoted; a delete_pending
 * one stays pending, because an upload cannot outvote a deletion. */
create or replace function public.fn_mark_object_live(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.storage_objects set state = 'live'
   where id = p_id and state in ('staged','live')
  returning id into v_id;
  return v_id is not null;
end $$;

/** Put an object beyond deletion until a date, with a reason. Evidence, not
 * content: quarantined uploads a suspension may be appealed against. */
create or replace function public.fn_hold_object(p_id uuid, p_until timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.storage_objects set state = 'held', retain_until = p_until
   where id = p_id and state <> 'gone'
  returning id into v_id;
  -- A held object is removed from the outbox: it is not due, and leaving it
  -- there would let a worker delete evidence on schedule.
  delete from public.deletion_outbox where object_id = p_id and completed_at is null;
  return v_id is not null;
end $$;

-- ---------------------------------------------------------------- outbox

/**
 * Queue objects for removal. Takes REGISTRY IDS: the locator is copied from
 * the registry row, never from the caller, so a compromised or careless caller
 * cannot aim a delete at someone else's bucket.
 *
 * Held evidence is skipped unless its deadline has passed. A repeat enqueue
 * never postpones an earlier authorised deletion.
 */
create or replace function public.fn_enqueue_deletions(
  p_objects jsonb, p_reason text, p_not_before timestamptz default now()
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int := 0;
begin
  if p_objects is null or jsonb_typeof(p_objects) <> 'array' then
    return 0;
  end if;

  with wanted as (
    select o.*
      from public.storage_objects o
      join lateral (select (jsonb_array_elements_text(p_objects))::uuid as id) w on w.id = o.id
     where o.state <> 'gone'
       and (o.state <> 'held' or coalesce(o.retain_until, now()) <= now())
  ), queued as (
    insert into public.deletion_outbox
      (object_id, backend, bucket, object_path, reason, not_before)
    select id, backend, bucket, path, p_reason, coalesce(p_not_before, now())
      from wanted
    on conflict (backend, bucket, object_path) do update
      -- An authorised deletion is never pushed further out by a later request.
      set not_before = least(public.deletion_outbox.not_before, excluded.not_before),
          reason = public.deletion_outbox.reason
      where public.deletion_outbox.completed_at is null
    returning object_id
  )
  update public.storage_objects o
     set state = 'delete_pending'
    from queued q
   where o.id = q.object_id and o.state <> 'gone';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

/** Lease due work. Attempts are counted at claim time: a worker that dies
 * without acknowledging must still move the row toward its budget. */
create or replace function public.fn_claim_deletions(p_limit int)
returns setof public.deletion_outbox
language sql security definer set search_path = public as $$
  with picked as (
    select id from public.deletion_outbox
     where completed_at is null
       and not_before <= now()
       and (lease_until is null or lease_until < now())
     order by not_before, id
     for update skip locked
     limit least(greatest(p_limit, 1), 100)
  )
  update public.deletion_outbox d
     set lease_token = gen_random_uuid(),
         lease_until = now() + interval '2 minutes',
         attempts = d.attempts + 1
    from picked
   where d.id = picked.id
  returning d.*;
$$;

/**
 * Acknowledge a deletion. A zero-row update is a STALE CLAIM, not a success:
 * the lease expired and someone else owns this object now.
 *
 * Failure keeps the row, records the error and backs off. After the D2 budget
 * (12 attempts over 24 hours) it is dead-lettered — still present, still
 * queryable, and loud.
 */
create or replace function public.fn_complete_deletion(
  p_id uuid, p_token uuid, p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_object uuid; v_attempts int; v_delay int;
begin
  if p_error is null then
    update public.deletion_outbox
       set completed_at = now(), lease_token = null, lease_until = null, last_error = null
     where id = p_id and lease_token = p_token and lease_until > now()
       and completed_at is null
    returning object_id into v_object;
    if v_object is null then
      return jsonb_build_object('acknowledged', false, 'reason', 'stale_or_done');
    end if;
    update public.storage_objects set state = 'gone' where id = v_object;
    return jsonb_build_object('acknowledged', true, 'state', 'gone');
  end if;

  select attempts into v_attempts from public.deletion_outbox
   where id = p_id and lease_token = p_token and lease_until > now() and completed_at is null;
  if v_attempts is null then
    return jsonb_build_object('acknowledged', false, 'reason', 'stale_or_done');
  end if;
  -- 1 minute doubling to an hour, jittered, inside the 24 h budget.
  v_delay := least(3600, (60 * power(2, least(v_attempts, 6)))::int);
  update public.deletion_outbox
     set lease_token = null, lease_until = null,
         last_error = left(p_error, 500),
         not_before = now() + make_interval(secs => v_delay + floor(random() * 30)::int)
   where id = p_id;
  if v_attempts >= public.fn_dispatch_limit('deletion_max_attempts', 12) then
    raise warning 'deletion_dead_letter %', p_id;
    return jsonb_build_object('acknowledged', true, 'state', 'dead_letter', 'attempts', v_attempts);
  end if;
  return jsonb_build_object('acknowledged', true, 'state', 'retry', 'attempts', v_attempts);
end $$;

-- D2: 12 attempts over 24 h, then dead-letter with an alert.
insert into public.dispatch_limits (key, value) values ('deletion_max_attempts', 12)
on conflict (key) do nothing;

-- ------------------------------------------------------- locator resolution

/**
 * Which bucket an object of this purpose lives in, for this backend. There is
 * no default and no fallback: `storageFor('supabase')` hardcoding `media` is
 * precisely the bug that let a delete aimed at an upload miss it entirely.
 */
create or replace function public.fn_bucket_for(p_backend text, p_purpose text)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if p_backend = 'r2' then
    return public.fn_storage_config('r2_bucket');
  end if;
  if p_purpose in ('media','thumb') then
    return 'media';
  end if;
  if p_purpose in ('upload','persona-photo','persona-zip','scratch','quarantine') then
    return 'uploads';
  end if;
  raise exception 'unknown object purpose %', p_purpose using errcode = 'P0001';
end $$;

/** Registry ids for everything a generation owns, registering what predates
 * the registry. The backend is the one RECORDED on the row, never a guess. */
create or replace function public.fn_track_generation_objects(p_gen uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare g record; v_ids uuid[] := '{}';
begin
  select user_id, media_path, thumb_path, storage_backend into g
    from public.generations where id = p_gen;
  if g is null then return v_ids; end if;

  if g.media_path is not null then
    v_ids := v_ids || public.fn_register_object(
      g.user_id, g.storage_backend,
      public.fn_bucket_for(g.storage_backend, 'media'), g.media_path, 'media');
  end if;
  if g.thumb_path is not null then
    v_ids := v_ids || public.fn_register_object(
      g.user_id, g.storage_backend,
      public.fn_bucket_for(g.storage_backend, 'thumb'), g.thumb_path, 'thumb');
  end if;
  return v_ids;
end $$;

/** The same for a persona: its moderated photos and its training ZIP. The
 * LoRA is NOT here — it is hosted by fal and tracked as a provider artifact. */
create or replace function public.fn_track_persona_objects(p_persona uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare p record; v_path text; v_ids uuid[] := '{}';
begin
  select id, user_id, photo_paths into p from public.personas where id = p_persona;
  if p is null then return v_ids; end if;

  foreach v_path in array coalesce(
    array(select jsonb_array_elements_text(coalesce(p.photo_paths, '[]'::jsonb))), '{}'::text[]
  ) loop
    v_ids := v_ids || public.fn_register_object(
      p.user_id, 'supabase', 'uploads', v_path, 'persona-photo');
  end loop;

  v_ids := v_ids || public.fn_register_object(
    p.user_id, 'supabase', 'uploads',
    'persona-zips/' || p.user_id::text || '/' || p.id::text || '.zip', 'persona-zip');
  return v_ids;
end $$;

-- ------------------------------------------------------------- lifecycle

/**
 * Remove a tombstoned generation once nothing is still running for it.
 *
 * A live job is the one thing that stops this: the provider may still hand us
 * bytes, and the finisher needs the row to put them on. The row disappears and
 * its objects are queued in the SAME transaction — never the row alone.
 */
create or replace function public.fn_reap_generation(p_gen uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; v_queued int;
begin
  if exists (select 1 from public.jobs where generation_id = p_gen and state <> 'done') then
    return jsonb_build_object('status', 'pending_job', 'objects', 0);
  end if;
  v_ids := public.fn_track_generation_objects(p_gen);
  v_queued := public.fn_enqueue_deletions(to_jsonb(v_ids), p_reason, now());
  delete from public.generations where id = p_gen;
  return jsonb_build_object('status', 'queued', 'objects', v_queued);
end $$;

create or replace function public.fn_reap_persona(p_persona uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; v_ids uuid[]; v_queued int;
begin
  if exists (
    select 1 from public.training_jobs where persona_id = p_persona and state <> 'done'
  ) then
    return jsonb_build_object('status', 'pending_job', 'objects', 0);
  end if;
  select id, user_id, lora_url into p from public.personas where id = p_persona;
  if p.id is null then return jsonb_build_object('status', 'gone', 'objects', 0); end if;

  v_ids := public.fn_track_persona_objects(p_persona);
  v_queued := public.fn_enqueue_deletions(to_jsonb(v_ids), p_reason, now());
  -- We do not hold the LoRA; fal does. Record the request rather than
  -- pretending the bytes are ours to remove.
  if p.lora_url is not null then
    insert into public.provider_artifact_deletions (user_id, provider, artifact_ref, status)
    values (p.user_id, 'fal', p.lora_url, 'requested')
    on conflict (provider, artifact_ref) do nothing;
  end if;
  delete from public.personas where id = p_persona;
  return jsonb_build_object('status', 'queued', 'objects', v_queued);
end $$;

/** Customer-facing delete of one generation. Hides it now, stops any work,
 * queues its bytes. Never blocks on storage. */
create or replace function public.fn_delete_generation(p_user uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_gen uuid;
begin
  -- A tombstoned row still answers: asking twice is the same request, not an
  -- error. Only a row that is really not there is not_found.
  select id into v_gen from public.generations
   where id = p_id and user_id = p_user for update;
  if v_gen is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  update public.generations set deleted_at = now()
   where id = p_id and deleted_at is null;
  -- Ask; never settle. Only the current lease may end a job.
  update public.jobs
     set cancel_requested_at = coalesce(cancel_requested_at, now()), next_run_at = now()
   where generation_id = p_id and state <> 'done';
  return public.fn_reap_generation(p_id, 'generation_deleted');
end $$;

create or replace function public.fn_delete_persona(p_user uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.personas
   where id = p_id and user_id = p_user for update;
  if v_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  update public.personas set deleted_at = now()
   where id = p_id and deleted_at is null;
  update public.training_jobs
     set cancel_requested_at = coalesce(cancel_requested_at, now()), next_run_at = now()
   where persona_id = p_id and state <> 'done';
  return public.fn_reap_persona(p_id, 'persona_deleted');
end $$;

/** Everything tombstoned that has since become safe to remove. Run by cron,
 * and again by each account-closure attempt. */
create or replace function public.fn_reap_deleted(p_user uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_reaped int := 0; v_waiting int := 0; v_out jsonb;
begin
  for r in
    select id from public.generations
     where deleted_at is not null and (p_user is null or user_id = p_user)
     order by deleted_at limit 500
  loop
    v_out := public.fn_reap_generation(r.id, 'tombstone_reaped');
    if v_out->>'status' = 'pending_job' then v_waiting := v_waiting + 1; end if;
    if v_out->>'status' <> 'pending_job' then v_reaped := v_reaped + 1; end if;
  end loop;

  for r in
    select id from public.personas
     where deleted_at is not null and (p_user is null or user_id = p_user)
     order by deleted_at limit 500
  loop
    v_out := public.fn_reap_persona(r.id, 'tombstone_reaped');
    if v_out->>'status' = 'pending_job' then v_waiting := v_waiting + 1; end if;
    if v_out->>'status' <> 'pending_job' then v_reaped := v_reaped + 1; end if;
  end loop;

  return jsonb_build_object('reaped', v_reaped, 'waiting', v_waiting);
end $$;

/**
 * The lapse purge, D2: the paid period IS the grace. It used to delete rows
 * with raw SQL and leave every byte behind; it now goes through the same
 * lifecycle as a customer's own delete.
 */
create or replace function public.fn_purge_lapsed()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_gens int := 0; v_personas int := 0;
begin
  for r in
    select g.id, g.user_id from public.generations g
      join public.subscriptions s on s.user_id = g.user_id
     where s.status in ('canceled','expired')
       and s.current_period_end < now()
       and g.deleted_at is null
     limit 2000
  loop
    perform public.fn_delete_generation(r.user_id, r.id);
    v_gens := v_gens + 1;
  end loop;

  for r in
    select p.id, p.user_id from public.personas p
      join public.subscriptions s on s.user_id = p.user_id
     where s.status in ('canceled','expired')
       and s.current_period_end < now()
       and p.deleted_at is null
     limit 2000
  loop
    perform public.fn_delete_persona(r.user_id, r.id);
    v_personas := v_personas + 1;
  end loop;

  return jsonb_build_object('generations', v_gens, 'personas', v_personas);
end $$;

-- ------------------------------------------------------- account closure

/**
 * Nothing new may be created for an account that has asked to be closed.
 *
 * This is a trigger rather than a check inside each RPC because the gateway
 * has more than one way to create content — reservations, `/edits/save`,
 * `/library/import`, uploads — and a closure that only blocked one of them
 * would quietly resurrect the account through another.
 *
 * Refunds are deliberately NOT blocked: settling work that was already paid
 * for has to keep working while the closure drains.
 */
create or replace function public.fn_refuse_closed_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then return new; end if;
  if exists (
    select 1 from public.profiles
     where id = new.user_id and deletion_requested_at is not null
  ) then
    raise exception 'account_closing' using errcode = 'P0001';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'generations','jobs','training_jobs','personas','uploads','billing_transactions'
  ] loop
    execute format('drop trigger if exists refuse_closed_account on public.%I', t);
    execute format(
      'create trigger refuse_closed_account before insert on public.%I
       for each row execute function public.fn_refuse_closed_account()', t);
  end loop;
end $$;

/**
 * Start a closure. Idempotent: asking twice returns the same request.
 *
 * It takes the same per-user money lock the reservation path takes, so a
 * closure cannot interleave with a charge. Content is hidden immediately and
 * every live job is asked to stop; nothing is settled here.
 */
create or replace function public.fn_request_account_deletion(
  p_user uuid, p_subscriptions jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select id into v_id from public.account_deletions
   where user_id = p_user and status <> 'completed';
  if v_id is null then
    insert into public.account_deletions (user_id, auth_user_id, status, subscriptions)
    values (p_user, p_user, 'processing', coalesce(p_subscriptions, '[]'::jsonb))
    returning id into v_id;
  end if;
  if v_id is not null then
    update public.account_deletions
       set subscriptions = case
             when jsonb_array_length(coalesce(p_subscriptions, '[]'::jsonb)) > 0
             then p_subscriptions else subscriptions end,
           updated_at = now()
     where id = v_id;
  end if;

  update public.profiles
     set deletion_requested_at = coalesce(deletion_requested_at, now())
   where id = p_user;

  update public.generations set deleted_at = now()
   where user_id = p_user and deleted_at is null;
  update public.personas set deleted_at = now()
   where user_id = p_user and deleted_at is null;
  update public.jobs
     set cancel_requested_at = coalesce(cancel_requested_at, now()), next_run_at = now()
   where user_id = p_user and state <> 'done';
  update public.training_jobs
     set cancel_requested_at = coalesce(cancel_requested_at, now()), next_run_at = now()
   where user_id = p_user and state <> 'done';

  return public.fn_advance_account_deletion(v_id);
end $$;

/**
 * Provider-side work this closure is still waiting on. 'unsupported' counts as
 * resolved: it is a limitation we disclose, not a promise we are still keeping.
 */
create or replace function public.fn_unresolved_artifacts(p_request uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select count(*) from public.provider_artifact_deletions
   where deletion_ref = p_request and status in ('requested','processing','failed');
$$;

/**
 * Move a closure as far as it can safely go, and say exactly what is left.
 *
 * It never reports "completed" while work is unresolved. Finalisation happens
 * only when no job is running and no content row is left; queued objects do
 * NOT block it, because the outbox carries its own copy of every locator and
 * survives the profile.
 */
create or replace function public.fn_advance_account_deletion(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record; v_jobs int; v_rows int; v_objects int; v_held int; v_provider int;
  v_unresolved jsonb;
begin
  select * into r from public.account_deletions where id = p_request for update;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.status = 'completed' then
    return jsonb_build_object('status', 'completed', 'requestId', r.id,
      'pendingObjects', 0, 'pendingJobs', 0, 'providerArtifacts', 0);
  end if;
  -- Already finalised, waiting only for the auth user to be removed by the
  -- worker that can call the auth API.
  if r.data_finalized_at is not null then
    return jsonb_build_object('status', 'processing', 'requestId', r.id,
      'authUserId', r.auth_user_id, 'pendingObjects',
      (select count(*) from public.deletion_outbox d
        join public.storage_objects o on o.id = d.object_id
       where d.completed_at is null and o.user_id is null),
      'pendingJobs', 0,
      'providerArtifacts', public.fn_unresolved_artifacts(r.id));
  end if;

  perform pg_advisory_xact_lock(hashtext(r.user_id::text));
  perform public.fn_reap_deleted(r.user_id);

  select count(*) into v_jobs from (
    select 1 from public.jobs where user_id = r.user_id and state <> 'done'
    union all
    select 1 from public.training_jobs where user_id = r.user_id and state <> 'done'
  ) q;
  select count(*) into v_rows from (
    select 1 from public.generations where user_id = r.user_id
    union all
    select 1 from public.personas where user_id = r.user_id
  ) q;
  select count(*) into v_objects
    from public.deletion_outbox d
    join public.storage_objects o on o.id = d.object_id
   where d.completed_at is null and o.user_id = r.user_id;
  select count(*) into v_held from public.storage_objects
   where user_id = r.user_id and state = 'held' and coalesce(retain_until, now()) > now();
  select count(*) into v_provider from public.provider_artifact_deletions
   where user_id = r.user_id and status in ('requested','processing','failed');

  v_unresolved := jsonb_build_object(
    'jobs', v_jobs, 'rows', v_rows, 'objects', v_objects,
    'held', v_held, 'providerArtifacts', v_provider);
  update public.account_deletions
     set unresolved = v_unresolved, updated_at = now(), status = 'processing'
   where id = r.id;

  -- Work that may still produce bytes keeps the customer's own data in place;
  -- an unconfirmed provider artifact does not, because holding the profile
  -- hostage to a third party's API would keep the data we CAN delete. It
  -- blocks completion instead (fn_complete_account_deletion), so the closure
  -- is never reported done while somebody else still holds a derived file.
  if v_jobs > 0 or v_rows > 0 then
    return jsonb_build_object('status', 'processing', 'requestId', r.id,
      'pendingObjects', v_objects, 'pendingJobs', v_jobs,
      'providerArtifacts', v_provider);
  end if;

  perform public.fn_finalize_account_deletion(r.id, r.user_id);
  return jsonb_build_object('status', 'processing', 'requestId', r.id,
    'authUserId', r.auth_user_id, 'pendingObjects', v_objects,
    'pendingJobs', 0, 'providerArtifacts', v_provider);
end $$;

/**
 * Anonymise what D2 keeps, then remove the profile.
 *
 * Financial rows and moderation evidence lose their owner and gain a
 * non-identifying reference to this closure. Quarantined evidence objects are
 * HELD to the appeal deadline rather than queued — an appeal against a
 * suspension outlives the account that was suspended.
 */
create or replace function public.fn_finalize_account_deletion(p_request uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  foreach t in array array[
    'ledger_entries','billing_transactions','billing_deliveries',
    'provider_expenses','training_provider_expenses','moderation_events'
  ] loop
    execute format(
      'update public.%I set user_id = null, deletion_ref = $1 where user_id = $2', t)
      using p_request, p_user;
  end loop;

  -- Evidence: 12 months from the enforcement action (D2).
  update public.storage_objects o
     set state = 'held',
         retain_until = greatest(coalesce(o.retain_until, m.created_at), m.created_at)
                        + interval '12 months'
    from public.moderation_events m
   where m.quarantine_path is not null
     and o.path = m.quarantine_path
     and o.bucket = 'uploads'
     and o.user_id = p_user
     and o.state <> 'gone';

  -- Request-level idempotency keys anchor requests that no longer exist; the
  -- money they guarded lives in the retained financial rows.
  delete from public.submissions where user_id = p_user;

  update public.storage_objects set user_id = null where user_id = p_user;
  -- The artifact is still out there; the closure that has to report it keeps
  -- a handle on it after the owner is gone.
  update public.provider_artifact_deletions
     set user_id = null, deletion_ref = p_request
   where user_id = p_user;

  delete from public.profiles where id = p_user;

  update public.account_deletions
     set user_id = null, data_finalized_at = now(), updated_at = now()
   where id = p_request;
end $$;

/** The worker confirms the auth user is gone; only then is a closure done. */
create or replace function public.fn_complete_account_deletion(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.account_deletions where id = p_request for update;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.data_finalized_at is null then
    return jsonb_build_object('status', 'processing', 'requestId', r.id,
      'reason', 'data_not_finalized');
  end if;
  -- A provider still holding a model trained on this customer's photos means
  -- the deletion is not finished, however much of it we did ourselves.
  if public.fn_unresolved_artifacts(p_request) > 0 then
    update public.account_deletions
       set auth_deleted_at = coalesce(auth_deleted_at, now()), updated_at = now()
     where id = p_request;
    return jsonb_build_object('status', 'processing', 'requestId', r.id,
      'reason', 'provider_artifacts_unresolved',
      'providerArtifacts', public.fn_unresolved_artifacts(p_request));
  end if;
  update public.account_deletions
     set status = 'completed', auth_deleted_at = now(), completed_at = now(),
         auth_user_id = null, updated_at = now()
   where id = p_request;
  return jsonb_build_object('status', 'completed', 'requestId', r.id);
end $$;

-- The old signature returned void and deleted a profile. Drop it explicitly:
-- a `create or replace` cannot change a return type, and leaving both would
-- let a deployed caller keep the one-statement version.
drop function if exists public.fn_delete_account(uuid);

/** The gateway's entry point. Returns what is actually true of the closure. */
create or replace function public.fn_delete_account(
  p_user uuid, p_subscriptions jsonb default '[]'::jsonb
) returns jsonb
language sql security definer set search_path = public as $$
  select public.fn_request_account_deletion(p_user, p_subscriptions);
$$;

-- ------------------------------------------------------------- backfill
--
-- Everything that already exists gets a locator, from exact database
-- references only. A path whose backend cannot be established from a row is
-- NOT guessed here; the read-only inventory (scripts/storage-inventory.mjs)
-- reports it for review.

do $$
declare v_r2 int;
begin
  select count(*) into v_r2 from public.generations
   where storage_backend = 'r2' and (media_path is not null or thumb_path is not null);
  -- Only demand the bucket name when there is actually an R2 object to name.
  if v_r2 > 0 then
    perform public.fn_storage_config('r2_bucket');
  end if;
end $$;

insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
select g.user_id, g.storage_backend,
       case when g.storage_backend = 'r2' then public.fn_storage_config('r2_bucket') else 'media' end,
       g.media_path, 'media', 'live'
  from public.generations g
 where g.media_path is not null
on conflict (backend, bucket, path) do nothing;

insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
select g.user_id, g.storage_backend,
       case when g.storage_backend = 'r2' then public.fn_storage_config('r2_bucket') else 'media' end,
       g.thumb_path, 'thumb', 'live'
  from public.generations g
 where g.thumb_path is not null
on conflict (backend, bucket, path) do nothing;

insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
select u.user_id, 'supabase', 'uploads', u.path,
       case when u.purpose = 'persona-photo' then 'persona-photo' else 'upload' end, 'live'
  from public.uploads u
on conflict (backend, bucket, path) do nothing;

insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
select p.user_id, 'supabase', 'uploads', photo, 'persona-photo', 'live'
  from public.personas p
  cross join lateral jsonb_array_elements_text(coalesce(p.photo_paths, '[]'::jsonb)) as photo
on conflict (backend, bucket, path) do nothing;

insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
select p.user_id, 'supabase', 'uploads',
       'persona-zips/' || p.user_id::text || '/' || p.id::text || '.zip', 'persona-zip', 'live'
  from public.personas p
 where jsonb_array_length(coalesce(p.photo_paths, '[]'::jsonb)) > 0
on conflict (backend, bucket, path) do nothing;

-- Quarantined evidence is registered as HELD from the start: it is kept on
-- purpose, and must never be mistaken for an orphan or swept up by a purge.
insert into public.storage_objects
  (user_id, backend, bucket, path, purpose, state, retain_until)
select m.user_id, 'supabase', 'uploads', m.quarantine_path, 'quarantine', 'held',
       m.created_at + interval '12 months'
  from public.moderation_events m
 where m.quarantine_path is not null
on conflict (backend, bucket, path) do nothing;

-- ------------------------------------------------------------------ grants

revoke all on function public.fn_storage_config(text) from public, anon, authenticated;
revoke all on function public.fn_bucket_for(text, text) from public, anon, authenticated;
revoke all on function public.fn_register_object(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.fn_mark_object_live(uuid) from public, anon, authenticated;
revoke all on function public.fn_hold_object(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fn_enqueue_deletions(jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fn_claim_deletions(int) from public, anon, authenticated;
revoke all on function public.fn_complete_deletion(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_track_generation_objects(uuid) from public, anon, authenticated;
revoke all on function public.fn_track_persona_objects(uuid) from public, anon, authenticated;
revoke all on function public.fn_reap_generation(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_reap_persona(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_reap_deleted(uuid) from public, anon, authenticated;
revoke all on function public.fn_delete_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_delete_persona(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_purge_lapsed() from public, anon, authenticated;
revoke all on function public.fn_request_account_deletion(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fn_advance_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.fn_finalize_account_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_complete_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.fn_delete_account(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.fn_storage_config(text) to service_role;
grant execute on function public.fn_bucket_for(text, text) to service_role;
grant execute on function public.fn_register_object(uuid, text, text, text, text) to service_role;
grant execute on function public.fn_mark_object_live(uuid) to service_role;
grant execute on function public.fn_hold_object(uuid, timestamptz) to service_role;
grant execute on function public.fn_enqueue_deletions(jsonb, text, timestamptz) to service_role;
grant execute on function public.fn_claim_deletions(int) to service_role;
grant execute on function public.fn_complete_deletion(uuid, uuid, text) to service_role;
grant execute on function public.fn_track_generation_objects(uuid) to service_role;
grant execute on function public.fn_track_persona_objects(uuid) to service_role;
grant execute on function public.fn_reap_generation(uuid, text) to service_role;
grant execute on function public.fn_reap_persona(uuid, text) to service_role;
grant execute on function public.fn_reap_deleted(uuid) to service_role;
grant execute on function public.fn_delete_generation(uuid, uuid) to service_role;
grant execute on function public.fn_delete_persona(uuid, uuid) to service_role;
grant execute on function public.fn_purge_lapsed() to service_role;
grant execute on function public.fn_request_account_deletion(uuid, jsonb) to service_role;
grant execute on function public.fn_advance_account_deletion(uuid) to service_role;
grant execute on function public.fn_unresolved_artifacts(uuid) to service_role;
grant execute on function public.fn_complete_account_deletion(uuid) to service_role;
grant execute on function public.fn_delete_account(uuid, jsonb) to service_role;

-- --------------------------------------------------------------------- crons

-- D2: the paid period is the grace. The old job kept a 30-day window AND
-- deleted rows without touching storage; both are gone.
select cron.unschedule(jobid) from cron.job where jobname = 'purge_lapsed_libraries';
select cron.schedule('purge_lapsed', '0 3 * * *', $$
  select public.fn_purge_lapsed();
$$);

-- Tombstoned content whose job has since finished.
select cron.schedule('reap_deleted_content', '*/5 * * * *', $$
  select public.fn_reap_deleted();
$$);

-- Closures move themselves forward; the worker only has to remove the auth
-- user once the data side is finalised.
select cron.schedule('advance_account_deletions', '*/5 * * * *', $$
  select public.fn_advance_account_deletion(id)
    from public.account_deletions
   where status <> 'completed';
$$);

-- ------------------------------------------------- the cleanup worker's clock
--
-- Postgres can queue a locator; it cannot make an HTTP call to R2 or delete an
-- auth user. Every five minutes pg_cron pokes the `cleanup-worker` function,
-- which drains the outbox and finishes closures.
--
-- Prerequisites are asserted, never skipped. A schedule that silently failed to
-- install would leave a queue of objects a customer has been told are deleted,
-- and closures that never complete — the exact lie this migration removes.
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net is required to drive the cleanup worker';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is required to drive the cleanup worker';
  end if;
  -- The URL and the shared secret live in Vault, not in this file: the worker
  -- secret in a migration is a credential in git.
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase vault is required: cleanup_worker_url and cleanup_worker_secret live there';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'cleanup_worker_url') then
    raise exception 'vault secret cleanup_worker_url is missing';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'cleanup_worker_secret') then
    raise exception 'vault secret cleanup_worker_secret is missing';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'drive_cleanup_worker';
select cron.schedule('drive_cleanup_worker', '*/5 * * * *', $schedule$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='cleanup_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='cleanup_worker_secret')),
    body := '{}'::jsonb
  );
$schedule$);
