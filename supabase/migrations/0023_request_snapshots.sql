-- 0023: what the customer actually asked for.
--
-- Retry reconstructed a request from the fields the client happened to still
-- hold: familyId, op, prompt, settings, parentId. Everything else was gone.
-- A mask retry failed "requires a mask". A video i2v retry failed
-- "bad_reference_count". A persona item retried as familyId='persona' and
-- failed "invalid_family". Style and persona were stamped into settings on the
-- way out and stripped by sanitizeSettings on the way back in.
--
-- The request is now recorded once, in full, by owned identity rather than by
-- signed URL — so a retry two weeks later still resolves.
-- (written 2026-09-20; apply AFTER 0022_thumbnails.sql)

create table if not exists public.request_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  version int not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists request_snapshots_user_idx
  on public.request_snapshots (user_id, created_at desc);
alter table public.request_snapshots enable row level security;

alter table public.generations
  add column if not exists snapshot_id uuid references public.request_snapshots on delete set null;
-- failure_code/failure_message are owned and written by P4/0019, not added here.

-- Existing rows have no snapshot; retry must refuse them with an explanation
-- rather than fail at the provider. `snapshot_id is null` is that signal.

-- The 'mask' upload purpose that the snapshot's maskUploadId points at is
-- already added by 0020_durable_dispatch.sql; `request_snapshots.sql` asserts
-- it, because a snapshot that names a mask is worthless if the registry will
-- not hold one.

-- ------------------------------------------------------- reserve + snapshot
--
-- Same signature and the same replay-first behaviour as 0020. The snapshot is
-- inserted inside this transaction, after replay and cap validation and before
-- the charge, so a rejected submission leaves no orphan snapshot and a replay
-- adds none. The client never supplies a snapshot id — it is generated here.
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
  v_snapshot jsonb; v_snapshot_id uuid;
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

  -- The snapshot is as required as the quote: a generation without one can
  -- never be retried, and there is no way to add it afterwards.
  v_snapshot := p_payload->'snapshot';
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then
    raise exception 'snapshot_required' using errcode = 'P0001';
  end if;
  if (v_snapshot->>'version') is null or (v_snapshot->>'version')::int < 1 then
    raise exception 'bad_snapshot' using errcode = 'P0001';
  end if;
  if (v_snapshot->>'catalogVersion') is null then
    raise exception 'bad_snapshot' using errcode = 'P0001';
  end if;
  if v_snapshot ? 'snapshotId' then
    raise exception 'bad_snapshot' using errcode = 'P0001';
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
  -- answered when the account has since run out of money. A replay returns the
  -- first attempt's result and writes no second snapshot.
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

  -- 5. Record the request, then charge. One snapshot per submission: a batch
  -- of four shares it, because they are four outputs of one request.
  insert into public.request_snapshots (user_id, version, body)
  values (p_user, (v_snapshot->>'version')::int, v_snapshot)
  returning id into v_snapshot_id;

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

  update public.generations set snapshot_id = v_snapshot_id
   where user_id = p_user and id = any(v_gen_ids);

  -- 7. The replay record is part of the same transaction.
  v_result := jsonb_build_object(
    'generationIds', to_jsonb(v_gen_ids), 'jobIds', to_jsonb(v_job_ids));
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

revoke all on function public.fn_reserve_generation(uuid, uuid, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_reserve_generation(uuid, uuid, text, jsonb, jsonb, jsonb)
  to service_role;
