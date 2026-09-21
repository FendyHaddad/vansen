-- 0020: durable dispatch — submission is a reservation, execution is a worker.
--
-- Before this, `POST /generations` charged in one transaction and inserted the
-- job rows in a separate statement whose error was ignored: a failed insert
-- left a charged, pending generation with no job, which the stale sweep (which
-- joins jobs) could never find. Caps were read with plain selects BEFORE the
-- charge, so four simultaneous submissions all saw two pending videos and all
-- passed a three-video cap. And every provider poll happened inside GET /jobs,
-- so closing the tab stranded the job until a timeout refunded it.
--
-- Everything here is one idea: the decision, the money and the work item are
-- written in the same transaction, and the work is executed by a worker that
-- holds a lease.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'lease_token'
  ) then
    raise exception '0020 requires 0019_job_settlement.sql — jobs.lease_token is missing';
  end if;
end $$;

-- ---------------------------------------------------------------- policy rows

-- Limits are server-owned data, never HTTP input. A cap the client can name is
-- not a cap.
create table if not exists public.dispatch_limits (
  key text primary key,
  value numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.dispatch_limits enable row level security;

insert into public.dispatch_limits (key, value) values
  ('max_pending_videos', 3),
  ('daily_user_video_usd', 40),
  ('daily_global_usd', 500),
  ('daily_provider_usd:google', 200),
  ('daily_provider_usd:openai', 200),
  ('daily_provider_usd:fal', 200),
  ('daily_provider_usd:runway', 200),
  ('persona_slots:studio', 2),
  ('persona_slots:pro', 5),
  ('persona_slots:owner', 5),
  ('persona_training_credits', 350),
  ('persona_training_usd', 2.0),
  ('persona_min_photos', 5),
  ('persona_max_photos', 20)
on conflict (key) do nothing;

create or replace function public.fn_dispatch_limit(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.dispatch_limits where key = p_key), p_default);
$$;

-- ------------------------------------------------------------- durable records

create table if not exists public.submissions (
  user_id uuid not null references public.profiles on delete cascade,
  idempotency_key uuid not null,
  body_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
alter table public.submissions enable row level security;

-- One job per generation. A duplicate would mean two workers dispatching the
-- same paid work, so an existing duplicate blocks the migration rather than
-- being silently deduplicated.
do $$
begin
  if exists (select 1 from public.jobs group by generation_id having count(*) > 1) then
    raise exception '0020: duplicate jobs per generation exist — resolve them before applying';
  end if;
end $$;

alter table public.jobs
  add column if not exists state text not null default 'ready',
  add column if not exists next_run_at timestamptz not null default now(),
  add column if not exists submit_attempts int not null default 0,
  add column if not exists poll_attempts int not null default 0,
  add column if not exists dispatch_key uuid not null default gen_random_uuid(),
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists last_error text;

alter table public.jobs drop constraint if exists jobs_state_check;
alter table public.jobs add constraint jobs_state_check
  check (state in ('ready','submitting','submitted','reconciling','done'));

-- Backfill from evidence, never from optimism: an inline or unknown dispatch
-- may already have cost money, so it is reconciled, not resubmitted.
update public.jobs j set state = case
  when g.status in ('done','failed') then 'done'
  when j.provider_ref is not null and j.provider_ref <> 'inline' then 'submitted'
  else 'reconciling'
end
from public.generations g
where g.id = j.generation_id and j.state = 'ready' and j.created_at < now();

create unique index if not exists one_generation_job on public.jobs (generation_id);
create index if not exists jobs_runnable_idx on public.jobs (next_run_at)
  where state <> 'done';

create table if not exists public.provider_expenses (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google','openai','fal','runway')),
  reserved_usd numeric(14,6) not null check (reserved_usd >= 0),
  actual_usd numeric(14,6) check (actual_usd >= 0),
  incurred_at timestamptz not null default now()
);
alter table public.provider_expenses enable row level security;
create index if not exists provider_expenses_window_idx
  on public.provider_expenses (incurred_at);

-- Training is real provider work with its own lifecycle; it does not borrow a
-- generation row to hang a job off.
create table if not exists public.training_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  persona_id uuid not null references public.personas on delete cascade,
  state text not null default 'ready'
    check (state in ('ready','submitting','submitted','reconciling','done')),
  provider text not null check (provider in ('google','openai','fal','runway')),
  provider_ref text,
  dispatch_key uuid not null default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb,
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  submit_attempts int not null default 0,
  poll_attempts int not null default 0,
  cancel_requested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.training_jobs enable row level security;
create unique index if not exists one_active_training_job
  on public.training_jobs (persona_id) where state <> 'done';
create index if not exists training_jobs_runnable_idx
  on public.training_jobs (next_run_at) where state <> 'done';

create table if not exists public.training_provider_expenses (
  job_id uuid primary key references public.training_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google','openai','fal','runway')),
  reserved_usd numeric(14,6) not null check (reserved_usd >= 0),
  actual_usd numeric(14,6) check (actual_usd >= 0),
  incurred_at timestamptz not null default now()
);
alter table public.training_provider_expenses enable row level security;
create index if not exists training_expenses_window_idx
  on public.training_provider_expenses (incurred_at);

-- ------------------------------------------------------------------- budgets

/**
 * Spend in the rolling 24 h window. `actual_usd` when the provider told us what
 * it really charged, the reservation otherwise — and a refunded job still
 * counts, because the money left our account whatever we told the customer.
 */
create or replace function public.fn_spend_window(
  p_user uuid default null,
  p_provider text default null,
  p_video_only boolean default false
) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(spend), 0) from (
    select coalesce(e.actual_usd, e.reserved_usd) as spend
      from public.provider_expenses e
      join public.jobs j on j.id = e.job_id
      join public.generations g on g.id = j.generation_id
     where e.incurred_at > now() - interval '24 hours'
       and (p_user is null or e.user_id = p_user)
       and (p_provider is null or e.provider = p_provider)
       and (not p_video_only or g.kind = 'video')
    union all
    select coalesce(t.actual_usd, t.reserved_usd)
      from public.training_provider_expenses t
     where t.incurred_at > now() - interval '24 hours'
       and (p_user is null or t.user_id = p_user)
       and (p_provider is null or t.provider = p_provider)
       and not p_video_only
  ) s;
$$;

/** When the oldest spend in the window rolls out of it. */
create or replace function public.fn_spend_resets_at(p_user uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(min(e.incurred_at), now()) + interval '24 hours'
    from public.provider_expenses e
   where e.user_id = p_user and e.incurred_at > now() - interval '24 hours';
$$;

-- --------------------------------------------------------------- reservation

/**
 * One transaction: check every cap against live data, charge, and write the
 * generation, the job and the expense together. A crash anywhere takes the
 * charge with it.
 *
 * p_key is required. The gateway mints one when the client did not send a
 * usable Idempotency-Key, so every submission has a replay record even if only
 * the client's own retries can address it.
 */
create or replace function public.fn_reserve_generation(
  p_user uuid,
  p_key uuid,
  p_hash text,
  p_items jsonb,
  p_quote jsonb,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count int; v_provider text; v_unit_credits int; v_unit_usd numeric;
  v_charge_type text; v_kind text; v_family text; v_family_name text;
  v_existing public.submissions%rowtype;
  v_pending int; v_batch_usd numeric; v_total int;
  v_gen record; v_job uuid;
  v_gen_ids uuid[] := '{}'; v_job_ids uuid[] := '{}';
  v_result jsonb;
begin
  -- 1. Validate the shape before anything is locked or charged.
  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if coalesce(v_count, 0) = 0 then
    raise exception 'empty_batch' using errcode = 'P0001';
  end if;
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;

  v_provider := p_quote->>'provider';
  if v_provider is null or v_provider not in ('google','openai','fal','runway') then
    raise exception 'unknown_provider' using errcode = 'P0001';
  end if;

  v_unit_credits := (p_quote->>'unitCredits')::int;
  v_unit_usd := (p_quote->>'unitProviderCostUsd')::numeric;
  v_charge_type := coalesce(p_quote->>'chargeType', 'generate');
  if v_unit_credits is null or v_unit_credits < 0 then
    raise exception 'bad_quote' using errcode = 'P0001';
  end if;
  if v_unit_usd is null or v_unit_usd < 0 or v_unit_usd = 'NaN'::numeric then
    raise exception 'bad_quote' using errcode = 'P0001';
  end if;
  if v_charge_type not in ('generate','edit','upscale') then
    raise exception 'bad_quote' using errcode = 'P0001';
  end if;

  select count(distinct item->>'kind') + count(distinct item->>'familyId')
       + count(distinct item->>'op') + count(distinct (item->>'priceCredits'))
    into v_count
    from jsonb_array_elements(p_items) item;
  if v_count <> 4 then
    raise exception 'mixed_batch' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_items);

  v_kind := p_items->0->>'kind';
  v_family := p_items->0->>'familyId';
  v_family_name := p_items->0->>'familyName';
  if (p_items->0->>'priceCredits')::int <> v_unit_credits then
    raise exception 'bad_quote' using errcode = 'P0001';
  end if;

  -- 2. Locks, always in this order: global budget, provider budget, then the
  -- user's money lock (the same key fn_charge_and_generate takes).
  perform pg_advisory_xact_lock(hashtext('budget:global'));
  perform pg_advisory_xact_lock(hashtext('budget:' || v_provider));
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  -- 3. Replay BEFORE capacity and credit checks: a valid retry must still be
  -- answered when the account has since run out of money.
  select * into v_existing from public.submissions
   where user_id = p_user and idempotency_key = p_key;
  if found and v_existing.body_hash <> p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if found then
    return v_existing.result;
  end if;

  -- 4. Caps, counting everything already reserved.
  select count(*) into v_pending
    from public.generations g
    join public.jobs j on j.generation_id = g.id
   where g.user_id = p_user and g.kind = 'video'
     and g.status = 'pending' and j.state <> 'done';
  if v_kind = 'video'
     and v_pending + v_count > public.fn_dispatch_limit('max_pending_videos', 3) then
    raise exception 'too_many_jobs' using errcode = 'P0001';
  end if;

  v_batch_usd := v_unit_usd * v_count;
  if v_kind = 'video'
     and public.fn_spend_window(p_user, null, true) + v_batch_usd
         > public.fn_dispatch_limit('daily_user_video_usd', 40) then
    raise exception 'daily_cap' using errcode = 'P0001',
      detail = to_char(public.fn_spend_resets_at(p_user), 'YYYY-MM-DD"T"HH24:MI:SSOF');
  end if;
  if public.fn_spend_window(null, null, false) + v_batch_usd
     > public.fn_dispatch_limit('daily_global_usd', 500) then
    raise exception 'daily_cap' using errcode = 'P0001', detail = 'global';
  end if;
  if public.fn_spend_window(null, v_provider, false) + v_batch_usd
     > public.fn_dispatch_limit('daily_provider_usd:' || v_provider, 200) then
    raise exception 'daily_cap' using errcode = 'P0001', detail = v_provider;
  end if;

  -- 5. Charge through the existing function: it owns plan/pack attribution.
  v_total := v_unit_credits * v_count;
  for v_gen in
    select * from public.fn_charge_and_generate(
      p_user, v_total, v_charge_type, v_family,
      coalesce(v_family_name, v_family), p_items)
  loop
    -- 6. One job and one expense per generation, each holding the UNIT cost.
    insert into public.jobs (generation_id, user_id, provider, state, payload)
    values (v_gen.id, p_user, v_provider, 'ready', coalesce(p_payload, '{}'::jsonb))
    returning id into v_job;
    insert into public.provider_expenses (job_id, user_id, provider, reserved_usd)
    values (v_job, p_user, v_provider, v_unit_usd);
    v_gen_ids := v_gen_ids || v_gen.id;
    v_job_ids := v_job_ids || v_job;
  end loop;

  -- 7. The replay record is part of the same transaction.
  v_result := jsonb_build_object(
    'generationIds', to_jsonb(v_gen_ids), 'jobIds', to_jsonb(v_job_ids));
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

-- ------------------------------------------------------------------ personas

/** Slot capacity under the same lock as the money; route-side counting is UI guidance. */
create or replace function public.fn_reserve_persona(
  p_user uuid, p_key uuid, p_hash text, p_name text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.submissions%rowtype;
  v_plan text; v_slots numeric; v_live int; v_persona uuid; v_result jsonb;
begin
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into v_existing from public.submissions
   where user_id = p_user and idempotency_key = p_key;
  if found and v_existing.body_hash <> p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if found then
    return v_existing.result;
  end if;

  select plan into v_plan from public.subscriptions
   where user_id = p_user and status = 'active';
  if v_plan is null then
    raise exception 'subscription_required' using errcode = 'P0001';
  end if;
  v_slots := public.fn_dispatch_limit('persona_slots:' || v_plan, 0);

  select count(*) into v_live from public.personas
   where user_id = p_user and status in ('draft','training','ready');
  if v_live >= v_slots then
    raise exception 'slot_limit' using errcode = 'P0001';
  end if;

  insert into public.personas (user_id, name) values (p_user, p_name)
  returning id into v_persona;

  v_result := jsonb_build_object('personaId', v_persona);
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

/** Charge the training fee and create the one training job, atomically. */
create or replace function public.fn_reserve_training(
  p_user uuid, p_persona uuid, p_key uuid, p_hash text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.submissions%rowtype;
  v_status text; v_photos int; v_provider text;
  v_credits int; v_usd numeric; v_job uuid; v_result jsonb;
begin
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;
  v_provider := coalesce(p_payload->>'provider', 'fal');
  if v_provider not in ('google','openai','fal','runway') then
    raise exception 'unknown_provider' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('budget:global'));
  perform pg_advisory_xact_lock(hashtext('budget:' || v_provider));
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into v_existing from public.submissions
   where user_id = p_user and idempotency_key = p_key;
  if found and v_existing.body_hash <> p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if found then
    return v_existing.result;
  end if;

  -- Ownership, status and photo count are re-read here; the route's copy is
  -- only what it showed the customer a moment ago.
  select status, jsonb_array_length(photo_paths) into v_status, v_photos
    from public.personas where id = p_persona and user_id = p_user for update;
  if v_status is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status not in ('draft','failed') then
    raise exception 'invalid_persona_status' using errcode = 'P0001';
  end if;
  if coalesce(v_photos, 0) < public.fn_dispatch_limit('persona_min_photos', 5)
     or coalesce(v_photos, 0) > public.fn_dispatch_limit('persona_max_photos', 20) then
    raise exception 'bad_photo_count' using errcode = 'P0001';
  end if;

  -- The price is catalog policy, never a client input.
  v_credits := public.fn_dispatch_limit('persona_training_credits', 350)::int;
  v_usd := public.fn_dispatch_limit('persona_training_usd', 2.0);
  if public.fn_spend_window(null, null, false) + v_usd
     > public.fn_dispatch_limit('daily_global_usd', 500) then
    raise exception 'daily_cap' using errcode = 'P0001', detail = 'global';
  end if;

  perform public.fn_charge_persona(p_user, p_persona, v_credits);

  insert into public.training_jobs (user_id, persona_id, provider, payload)
  values (p_user, p_persona, v_provider, coalesce(p_payload, '{}'::jsonb))
  returning id into v_job;
  insert into public.training_provider_expenses (job_id, user_id, provider, reserved_usd)
  values (v_job, p_user, v_provider, v_usd);

  v_result := jsonb_build_object('trainingJobId', v_job, 'personaId', p_persona);
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

/**
 * Settle a training job exactly once, fenced by the worker's lease.
 *
 * A provider-hosted LoRA is recorded as what it is — a URL we do not own. A
 * fabricated local path would be a file nobody ever wrote.
 */
create or replace function public.fn_settle_training(
  p_job uuid, p_token uuid, p_outcome text, p_lora_url text, p_error text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_persona uuid; v_state text; v_status text;
  v_cp int; v_cpack int; v_refunded int := 0;
begin
  select user_id, persona_id, state into v_user, v_persona, v_state
    from public.training_jobs where id = p_job;
  if v_user is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  select state into v_state from public.training_jobs where id = p_job for update;
  if v_state = 'done' then
    return jsonb_build_object('settled', false, 'previous', 'done', 'refunded', 0);
  end if;
  -- Only the current lease may settle: a worker whose lease expired mid-flight
  -- must not overwrite the worker that took over.
  if not exists (
    select 1 from public.training_jobs
     where id = p_job and lease_token = p_token and lease_until > now()
  ) then
    return jsonb_build_object('settled', false, 'previous', v_state, 'refunded', 0);
  end if;

  select status, charged_plan, charged_pack into v_status, v_cp, v_cpack
    from public.personas where id = v_persona for update;
  if v_status is distinct from 'training' then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  update public.training_jobs
     set state = 'done', lease_token = null, lease_until = null,
         last_error = p_error, updated_at = now()
   where id = p_job;

  if p_outcome = 'done' then
    update public.personas
       set status = 'ready', lora_url = p_lora_url, error = null, trained_at = now()
     where id = v_persona;
    return jsonb_build_object('settled', true, 'previous', 'training', 'refunded', 0);
  end if;

  update public.personas set status = 'failed', error = p_error where id = v_persona;
  if coalesce(v_cp, 0) > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp,
            'refund:persona:' || v_persona::text || ':plan')
    on conflict do nothing;
    v_refunded := v_refunded + v_cp;
  end if;
  if coalesce(v_cpack, 0) > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack,
            'refund:persona:' || v_persona::text || ':pack')
    on conflict do nothing;
    v_refunded := v_refunded + v_cpack;
  end if;
  return jsonb_build_object('settled', true, 'previous', 'training', 'refunded', v_refunded);
end $$;

-- --------------------------------------------------------------------- grants

revoke all on function public.fn_dispatch_limit(text, numeric) from public, anon, authenticated;
revoke all on function public.fn_spend_window(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.fn_spend_resets_at(uuid) from public, anon, authenticated;
revoke all on function public.fn_reserve_generation(uuid, uuid, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.fn_reserve_persona(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fn_reserve_training(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.fn_settle_training(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.fn_dispatch_limit(text, numeric) to service_role;
grant execute on function public.fn_spend_window(uuid, text, boolean) to service_role;
grant execute on function public.fn_spend_resets_at(uuid) to service_role;
grant execute on function public.fn_reserve_generation(uuid, uuid, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.fn_reserve_persona(uuid, uuid, text, text) to service_role;
grant execute on function public.fn_reserve_training(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.fn_settle_training(uuid, uuid, text, text, text) to service_role;

-- ----------------------------------------------------------- lease and claim

/**
 * Take a lease on runnable work. The claim NEVER changes lifecycle state: a
 * job that was `submitting` stays `submitting`, because the only honest reader
 * of "did this reach the provider" is reconciliation, not a fresh claim.
 */
create or replace function public.fn_claim_jobs(p_limit int)
returns setof public.jobs
language sql security definer set search_path = public as $$
  with picked as (
    select id from public.jobs
     where state <> 'done' and next_run_at <= now()
       and (lease_until is null or lease_until < now())
     order by next_run_at, id
     for update skip locked
     limit least(p_limit, 50)
  )
  update public.jobs j
     set lease_token = gen_random_uuid(),
         lease_until = now() + interval '2 minutes',
         updated_at = now()
    from picked
   where j.id = picked.id
  returning j.*;
$$;

create or replace function public.fn_renew_job_lease(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.jobs set lease_until = now() + interval '2 minutes', updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

/**
 * Hand the lease back with an explicit next state. Nothing here guesses: the
 * caller says what it proved, and a caller whose lease expired proves nothing.
 */
create or replace function public.fn_release_job(
  p_job uuid,
  p_token uuid,
  p_state text,
  p_provider_ref text default null,
  p_delay_seconds int default 0,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_state not in ('ready','submitting','submitted','reconciling','done') then
    raise exception 'bad_state' using errcode = 'P0001';
  end if;
  update public.jobs
     set state = p_state,
         provider_ref = coalesce(p_provider_ref, provider_ref),
         next_run_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)),
         last_error = p_error,
         lease_token = null,
         lease_until = null,
         updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

/** ready -> submitting, fenced. No updated row means no remote call. */
create or replace function public.fn_begin_submit(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.jobs
     set state = 'submitting', submit_attempts = submit_attempts + 1, updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now() and state = 'ready'
  returning id into v_id;
  return v_id is not null;
end $$;

/** Persist a provider reference WITHOUT giving up the lease. */
create or replace function public.fn_record_provider_ref(
  p_job uuid, p_token uuid, p_ref text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.jobs set provider_ref = p_ref, updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

/** Count a poll attempt without releasing the lease. */
create or replace function public.fn_count_poll(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.jobs set poll_attempts = poll_attempts + 1, updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

-- The same five, for training work. Training does not borrow a generation row.
create or replace function public.fn_claim_training_jobs(p_limit int)
returns setof public.training_jobs
language sql security definer set search_path = public as $$
  with picked as (
    select id from public.training_jobs
     where state <> 'done' and next_run_at <= now()
       and (lease_until is null or lease_until < now())
     order by next_run_at, id
     for update skip locked
     limit least(p_limit, 50)
  )
  update public.training_jobs t
     set lease_token = gen_random_uuid(),
         lease_until = now() + interval '2 minutes',
         updated_at = now()
    from picked
   where t.id = picked.id
  returning t.*;
$$;

create or replace function public.fn_release_training_job(
  p_job uuid,
  p_token uuid,
  p_state text,
  p_provider_ref text default null,
  p_delay_seconds int default 0,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_state not in ('ready','submitting','submitted','reconciling','done') then
    raise exception 'bad_state' using errcode = 'P0001';
  end if;
  update public.training_jobs
     set state = p_state,
         provider_ref = coalesce(p_provider_ref, provider_ref),
         next_run_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)),
         last_error = p_error,
         lease_token = null,
         lease_until = null,
         updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function public.fn_begin_training_submit(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.training_jobs
     set state = 'submitting', submit_attempts = submit_attempts + 1, updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now() and state = 'ready'
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function public.fn_record_training_ref(
  p_job uuid, p_token uuid, p_ref text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.training_jobs set provider_ref = p_ref, updated_at = now()
   where id = p_job and lease_token = p_token and lease_until > now()
  returning id into v_id;
  return v_id is not null;
end $$;

/**
 * Release abandoned leases — and ONLY the lease. Setting state back to `ready`
 * here is what would resubmit paid work that is already running; the state
 * machine decides that, from evidence.
 */
create or replace function public.fn_expire_leases()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int; v_training int;
begin
  update public.jobs set lease_token = null, lease_until = null
   where lease_until is not null and lease_until < now();
  get diagnostics v_count = row_count;
  update public.training_jobs set lease_token = null, lease_until = null
   where lease_until is not null and lease_until < now();
  get diagnostics v_training = row_count;
  return v_count + v_training;
end $$;

revoke all on function public.fn_claim_jobs(int) from public, anon, authenticated;
revoke all on function public.fn_renew_job_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_release_job(uuid, uuid, text, text, int, text) from public, anon, authenticated;
revoke all on function public.fn_begin_submit(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_record_provider_ref(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_count_poll(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_claim_training_jobs(int) from public, anon, authenticated;
revoke all on function public.fn_release_training_job(uuid, uuid, text, text, int, text) from public, anon, authenticated;
revoke all on function public.fn_begin_training_submit(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_record_training_ref(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_expire_leases() from public, anon, authenticated;

grant execute on function public.fn_claim_jobs(int) to service_role;
grant execute on function public.fn_renew_job_lease(uuid, uuid) to service_role;
grant execute on function public.fn_release_job(uuid, uuid, text, text, int, text) to service_role;
grant execute on function public.fn_begin_submit(uuid, uuid) to service_role;
grant execute on function public.fn_record_provider_ref(uuid, uuid, text) to service_role;
grant execute on function public.fn_count_poll(uuid, uuid) to service_role;
grant execute on function public.fn_claim_training_jobs(int) to service_role;
grant execute on function public.fn_release_training_job(uuid, uuid, text, text, int, text) to service_role;
grant execute on function public.fn_begin_training_submit(uuid, uuid) to service_role;
grant execute on function public.fn_record_training_ref(uuid, uuid, text) to service_role;
grant execute on function public.fn_expire_leases() to service_role;

-- --------------------------------------------- settlement, extended for P5
--
-- Two additions to P4's contract, both about not lying to the state machine:
-- a winning settlement finishes the JOB as well as the generation (and gives
-- up its lease), and a caller with no lease can no longer refund work that a
-- worker is actively running.

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

  -- A caller that claims a lease must actually hold a live one.
  if exists (
    select 1 from public.jobs
    where id = p_job
      and (lease_token is not null or p_lease_token is not null)
      and (lease_token is distinct from p_lease_token or lease_until <= now())
  ) then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if v_status is distinct from p_expected_state then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if p_outcome not in ('done', 'failed') then raise exception 'invalid_outcome'; end if;

  -- 'done' without verified media is the defect this function exists to stop:
  -- a library row the customer paid for that points at nothing.
  if p_outcome = 'done' and (p_media_path is null or p_backend not in ('supabase', 'r2')) then
    raise exception 'verified_media_required';
  end if;

  if p_outcome = 'done' then
    update public.generations set
      status = 'done', failure_code = null, failure_message = null,
      media_path = coalesce(p_media_path, media_path),
      storage_backend = coalesce(p_backend, storage_backend),
      duration_s = coalesce((p_meta->>'durationS')::numeric, duration_s),
      width = coalesce((p_meta->>'width')::int, width),
      height = coalesce((p_meta->>'height')::int, height)
    where id = v_gen;
    update public.jobs set state = 'done', lease_token = null, lease_until = null,
      updated_at = now() where id = p_job;
    insert into public.notification_outbox (user_id, generation_id, event)
      values (v_user, v_gen, 'generation_done');
    return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', 0);
  end if;

  update public.generations set status = 'failed',
    failure_code = case
      when coalesce(p_failure_code, p_error) = 'cancelled' then 'cancelled'
      when p_failure_code in ('moderation', 'provider_error', 'timeout', 'store_failed')
        then p_failure_code
      else 'generation_failed' end,
    failure_message = case when coalesce(p_failure_code, p_error) = 'cancelled'
      then 'Cancelled · Refunded' else 'Generation failed. Your credits were refunded.' end
    where id = v_gen;
  update public.jobs set error = coalesce(p_error, 'failed'), state = 'done',
    lease_token = null, lease_until = null, updated_at = now() where id = p_job;

  -- ledger_refund_once (unique on note where type='refund') makes each bucket
  -- refundable exactly once per generation, however often this is called.
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
    select v_user, v_gen, 'generation_failed',
           jsonb_build_object('code', coalesce(p_failure_code, 'generation_failed'))
    where coalesce(p_failure_code, p_error, '') <> 'cancelled';

  return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', v_refunded);
end $$;

/**
 * The timeout sweep is no longer allowed to refund work that may be running.
 *
 * A job that was handed to a provider has probably cost money; "we waited long
 * enough" is not evidence that it failed. Those go back into reconciliation,
 * where the worker asks the provider. Only work that never left the building
 * can be failed on a timeout.
 */
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_state text;
begin
  select state into v_state from public.jobs where id = p_job;
  if v_state is null then
    return;
  end if;
  if v_state in ('submitting', 'submitted', 'reconciling') then
    update public.jobs
       set state = 'reconciling', next_run_at = now(), last_error = p_error, updated_at = now()
     where id = p_job;
    return;
  end if;
  perform public.fn_settle_job(p_job, 'failed', null, null, '{}'::jsonb, p_error);
end $$;

-- Stale work is reconciled, not refunded. Both sweeps only make work runnable
-- again; the worker is what decides an outcome.
select cron.unschedule(jobid) from cron.job where jobname = 'fail_stale_jobs';
select cron.schedule('reconcile_stale_jobs', '*/5 * * * *', $$
  select public.fn_expire_leases();
  update public.jobs j set state = 'reconciling', next_run_at = now()
    from public.generations g
   where g.id = j.generation_id
     and g.status = 'pending'
     and j.state in ('submitting', 'submitted')
     and j.lease_until is null
     and j.updated_at < now() - (
       case when g.kind = 'video' then interval '30 minutes' else interval '10 minutes' end
     );
$$);

select cron.unschedule(jobid) from cron.job where jobname = 'fail_stale_persona_trainings';
select cron.schedule('reconcile_stale_trainings', '*/5 * * * *', $$
  update public.training_jobs set state = 'reconciling', next_run_at = now()
   where state in ('submitting', 'submitted')
     and lease_until is null
     and updated_at < now() - interval '30 minutes';
$$);

-- An edit mask is a stored, owned upload now: the worker dispatches from the
-- registry, and a base64 blob in a job payload would be an unbounded row with
-- no owner and no moderation record.
alter table public.uploads drop constraint if exists uploads_purpose_check;
alter table public.uploads add constraint uploads_purpose_check
  check (purpose in ('reference', 'persona-photo', 'mask'));

-- ---------------------------------------------------------- the worker's clock
--
-- Nothing above runs on its own. This is the heartbeat that makes dispatch
-- durable: every minute, whether or not a single client is connected, pg_cron
-- pokes the `job-worker` function and it claims, submits, polls and settles.
--
-- Prerequisites are asserted, never skipped: a schedule that silently failed to
-- install would leave paid work sitting in `ready` with nobody looking at it,
-- which is exactly the failure this whole migration exists to remove.
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net is required to drive the job worker';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is required to drive the job worker';
  end if;
  -- The URL and the shared secret live in Vault, not in this file: a function
  -- URL in the schema is harmless, but the worker secret in a migration is a
  -- credential in git.
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase vault is required: job_worker_url and job_worker_secret live there';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'job_worker_url') then
    raise exception 'vault secret job_worker_url is missing';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'job_worker_secret') then
    raise exception 'vault secret job_worker_secret is missing';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'drive_job_worker';
select cron.schedule('drive_job_worker', '* * * * *', $schedule$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='job_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='job_worker_secret')),
    body := '{}'::jsonb
  );
$schedule$);
