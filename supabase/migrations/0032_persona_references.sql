-- 0032: persona as saved references (spec 2026-09-23-persona-references-design).
--
-- A persona is five guided photos, sent to Nano Banana Pro at generation time.
-- Nothing is trained and no provider keeps a file for us, so the LoRA pipeline
-- goes: its tables, functions and cron. Pre-launch personas are deleted.

-- ------------------------------------------------ 1. old personas go first
-- Their photos and training ZIPs are queued through the existing lifecycle
-- while the old functions and columns still exist.
do $$
declare r record;
begin
  update public.training_jobs set state = 'done' where state <> 'done';
  for r in select id, user_id from public.personas loop
    perform public.fn_delete_persona(r.user_id, r.id);
  end loop;
end $$;

-- LoRA files at fal from pre-launch test personas: nothing will chase them, so
-- say so instead of keeping every closure open forever.
update public.provider_artifact_deletions
   set status = 'unsupported',
       last_error = 'pre-launch test data: LoRA pipeline retired'
 where status in ('requested','processing','failed')
   and provider = 'fal';

-- ------------------------------------------------ 2. the training pipeline
select cron.unschedule(jobid) from cron.job where jobname = 'reconcile_stale_trainings';

drop function if exists public.fn_reserve_training(uuid, uuid, uuid, text, jsonb);
drop function if exists public.fn_settle_training(uuid, uuid, text, text, text);
drop function if exists public.fn_claim_training_jobs(int);
drop function if exists public.fn_release_training_job(uuid, uuid, text, text, int, text);
drop function if exists public.fn_begin_training_submit(uuid, uuid);
drop function if exists public.fn_record_training_ref(uuid, uuid, text);
drop function if exists public.fn_charge_persona(uuid, uuid, int);
drop function if exists public.fn_fail_persona(uuid, text);

-- Money records stay; they just stop pointing at a table that is gone.
alter table public.training_provider_expenses
  drop constraint if exists training_provider_expenses_job_id_fkey;
drop trigger if exists refuse_closed_account on public.training_jobs;
drop table public.training_jobs;

delete from public.dispatch_limits
 where key in ('persona_training_credits','persona_training_usd','persona_min_photos','persona_max_photos');

-- ------------------------------------------------ 3. the new persona shape
alter table public.personas
  drop column photo_paths,
  drop column lora_url,
  drop column trigger_word,
  drop column provider_ref,
  drop column error,
  drop column charged_plan,
  drop column charged_pack,
  drop column training_started_at,
  drop column trained_at;

alter table public.personas
  add column photos jsonb not null default jsonb_build_object(
    'front', null, 'left_three_quarter', null, 'right_three_quarter', null,
    'left_profile', null, 'right_profile', null),
  add column consent_attested_at timestamptz not null default now();

alter table public.personas alter column consent_attested_at drop default;

alter table public.personas drop constraint if exists personas_status_check;
alter table public.personas add constraint personas_status_check
  check (status in ('draft','ready'));

-- Exactly the five slot keys; each value a path or null. A CHECK cannot hold
-- a subquery, so the shape lives in an immutable helper.
create or replace function public.fn_persona_photos_valid(p jsonb)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select jsonb_typeof(p) = 'object'
     and (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) k)
         = array['front','left_profile','left_three_quarter','right_profile','right_three_quarter']
     and not exists (
       select 1 from jsonb_each(p) e
        where jsonb_typeof(e.value) not in ('string','null'));
$$;

alter table public.personas add constraint personas_photos_shape
  check (public.fn_persona_photos_valid(photos));

-- Every slot filled. `ready` means exactly this, and the table says so: no
-- writer, however it got here, can mark a persona ready with a slot missing
-- or leave a complete one a draft.
create or replace function public.fn_persona_photos_complete(p jsonb)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select not exists (
    select 1 from jsonb_each(p) e where jsonb_typeof(e.value) = 'null');
$$;

alter table public.personas add constraint personas_ready_complete
  check ((status = 'ready') = public.fn_persona_photos_complete(photos));

-- ------------------------------------------------ 4. slots and photos

/** Slot capacity under the same lock as the money. Consent is recorded here. */
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

  -- The gateway's activePlan rule exactly: anything but expired, and a
  -- canceled plan (Stripe sets it on cancel-at-period-end) until its paid
  -- period ends.
  select plan into v_plan from public.subscriptions
   where user_id = p_user and status <> 'expired'
     and not (status = 'canceled' and current_period_end is not null
              and current_period_end < now());
  if v_plan is null then
    raise exception 'subscription_required' using errcode = 'P0001';
  end if;
  v_slots := public.fn_dispatch_limit('persona_slots:' || v_plan, 0);

  select count(*) into v_live from public.personas
   where user_id = p_user and deleted_at is null and status in ('draft','ready');
  if v_live >= v_slots then
    raise exception 'slot_limit' using errcode = 'P0001';
  end if;

  insert into public.personas (user_id, name, consent_attested_at)
  values (p_user, p_name, now())
  returning id into v_persona;

  v_result := jsonb_build_object('personaId', v_persona);
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

/**
 * Put one moderated photo in one slot. The photo it replaces is queued for
 * deletion in the same transaction; the status is ready exactly when every
 * slot is filled.
 *
 * The photo must still be alive in the registry (every upload is registered
 * before its bytes are written, so a missing row is refused too): a photo
 * already queued for deletion would be removed from under this persona. And
 * it must not belong to another persona, whose deletion would take it along.
 */
create or replace function public.fn_set_persona_photo(
  p_user uuid, p_persona uuid, p_slot text, p_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_photos jsonb; v_old text; v_ids uuid[] := '{}'; v_status text;
begin
  if coalesce(p_slot, '') not in ('front','left_three_quarter','right_three_quarter','left_profile','right_profile') then
    raise exception 'invalid_slot' using errcode = 'P0001';
  end if;
  -- The same per-user lock as fn_reserve_persona and account closure: the
  -- guards below and the write that follows them see one consistent state.
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  if not exists (
    select 1 from public.uploads
     where path = p_path and user_id = p_user
       and purpose = 'persona-photo' and moderation = 'allowed'
  ) then
    raise exception 'invalid_photo' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.storage_objects
     where backend = 'supabase' and bucket = 'uploads' and path = p_path
       and state in ('staged','live')
  ) then
    raise exception 'invalid_photo' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.personas p, jsonb_each_text(p.photos) e
     where p.user_id = p_user and p.id <> p_persona and e.value = p_path
  ) then
    raise exception 'invalid_photo' using errcode = 'P0001';
  end if;

  select photos into v_photos from public.personas
   where id = p_persona and user_id = p_user and deleted_at is null
   for update;
  if v_photos is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_old := v_photos->>p_slot;
  v_photos := jsonb_set(v_photos, array[p_slot], to_jsonb(p_path));
  v_status := case
    when exists (select 1 from jsonb_each(v_photos) e where jsonb_typeof(e.value) = 'null')
    then 'draft' else 'ready' end;
  update public.personas set photos = v_photos, status = v_status where id = p_persona;

  -- A photo another slot still holds is not ours to delete yet.
  if v_old is not null and v_old <> p_path
     and not exists (select 1 from jsonb_each_text(v_photos) e where e.value = v_old) then
    v_ids := v_ids || public.fn_register_object(p_user, 'supabase', 'uploads', v_old, 'persona-photo');
    perform public.fn_enqueue_deletions(to_jsonb(v_ids), 'persona_photo_replaced', now());
  end if;

  return jsonb_build_object('status', v_status,
    'replaced', v_old is not null and v_old <> p_path);
end $$;

-- ------------------------------------------------ 5. deletion, new shape

/** A persona's objects are its photos. Nothing is held by a provider. */
create or replace function public.fn_track_persona_objects(p_persona uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare p record; v_path text; v_ids uuid[] := '{}';
begin
  select id, user_id, photos into p from public.personas where id = p_persona;
  if p is null then return v_ids; end if;
  for v_path in select value from jsonb_each_text(p.photos) where value is not null loop
    v_ids := v_ids || public.fn_register_object(
      p.user_id, 'supabase', 'uploads', v_path, 'persona-photo');
  end loop;
  return v_ids;
end $$;

create or replace function public.fn_reap_persona(p_persona uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; v_queued int;
begin
  if not exists (select 1 from public.personas where id = p_persona) then
    return jsonb_build_object('status', 'gone', 'objects', 0);
  end if;
  v_ids := public.fn_track_persona_objects(p_persona);
  v_queued := public.fn_enqueue_deletions(to_jsonb(v_ids), p_reason, now());
  delete from public.personas where id = p_persona;
  return jsonb_build_object('status', 'queued', 'objects', v_queued);
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
  update public.personas set deleted_at = now() where id = p_id and deleted_at is null;
  return public.fn_reap_persona(p_id, 'persona_deleted');
end $$;

-- ------------------------------------------------ 6. functions that read training_jobs
--
-- Copied verbatim from their latest definitions (0021, 0026, 0020, 0015) with
-- only the training lines removed. fn_expire_leases runs every five minutes
-- from the reconcile_stale_jobs cron, and backoffice_feature_usage read the
-- dropped training_started_at column; both would fail at run time otherwise.

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

  return public.fn_advance_account_deletion(v_id);
end $$;

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

  select count(*) into v_jobs from public.jobs
   where user_id = r.user_id and state <> 'done';
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

create or replace function public.fn_check_alerts()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int; v_usd numeric(14,6); v_found jsonb := '[]'::jsonb;
begin
  -- 1. Money taken, entitlement not granted. The worst outcome in the product:
  --    the customer paid and got nothing.
  select count(*) into v_n from public.fn_paid_unfulfilled(now() - interval '1 day');
  if v_n > 0 then
    perform public.fn_raise_alert('paid_unfulfilled', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('paid_unfulfilled'::text);
  end if;

  -- 2. Marked done with nothing to show. Charged, and the library shows a
  --    broken tile.
  select count(*) into v_n from public.generations
   where status = 'done' and coalesce(media_path, '') = ''
     and created_at > now() - interval '7 days';
  if v_n > 0 then
    perform public.fn_raise_alert('done_without_media', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('done_without_media'::text);
  end if;

  -- 3. A job nobody is working on: its lease keeps expiring, which means the
  --    worker keeps dying on it.
  select count(*) into v_n from public.jobs
   where state in ('submitting','reconciling')
     and (progress_at < now() - interval '10 minutes' or reconcile_attempts >= 10);
  if v_n > 0 then
    perform public.fn_raise_alert('jobs_stuck', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('jobs_stuck'::text);
  end if;

  -- 5. Bytes we promised to delete and have not. A legal exposure, not a
  --    performance problem.
  select count(*) into v_n from public.deletion_outbox
   where completed_at is null and not_before <= now()
     and (attempts >= 5 or not_before < now() - interval '24 hours');
  if v_n > 0 then
    perform public.fn_raise_alert('deletion_stuck', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('deletion_stuck'::text);
  end if;

  -- 6. Notifications that will never be delivered. The customer is waiting for
  --    a message that is not coming. P4 already gives up explicitly, so this
  --    reads its dead-letter mark rather than guessing from an attempt count.
  select count(*) into v_n from public.notification_outbox
   where dead_letter_at is not null and sent_at is null;
  if v_n > 0 then
    perform public.fn_raise_alert('notifications_dead', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('notifications_dead'::text);
  end if;

  -- 7. Provider spend. Video is expensive enough that a loop costs real money
  --    within the hour.
  select coalesce(sum(cost), 0) into v_usd from (
    select coalesce(actual_usd, reserved_usd) as cost from public.provider_expenses
     where incurred_at > now() - interval '1 hour'
    union all
    select coalesce(actual_usd, reserved_usd) from public.training_provider_expenses
     where incurred_at > now() - interval '1 hour'
  ) expenses;
  if v_usd > 50 then
    perform public.fn_raise_alert('provider_burn', 'warn', jsonb_build_object('usd_last_hour', v_usd));
    v_found := v_found || to_jsonb('provider_burn'::text);
  end if;

  -- 8. A moderation strike surge, which usually means the gate broke open.
  select count(*) into v_n from public.moderation_events
   where created_at > now() - interval '1 hour';
  if v_n > 100 then
    perform public.fn_raise_alert('moderation_surge', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('moderation_surge'::text);
  end if;

  -- Only now, having completed every check, is it safe to close anything.
  perform public.fn_resolve_checked_alerts(v_found);
  return v_found;
end $$;

/**
 * Release abandoned leases — and ONLY the lease. Setting state back to `ready`
 * here is what would resubmit paid work that is already running; the state
 * machine decides that, from evidence.
 */
create or replace function public.fn_expire_leases()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update public.jobs set lease_token = null, lease_until = null
   where lease_until is not null and lease_until < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.backoffice_feature_usage(p_days int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since timestamptz;
  v_out jsonb;
begin
  if p_days < 1 or p_days > 365 then
    raise exception 'days must be 1-365' using errcode = 'P0001';
  end if;
  v_since := now() - make_interval(days => p_days);

  select jsonb_build_object(
    'days', p_days,
    'totalGenerations', (select count(*) from generations where created_at >= v_since),
    'personas',
      (select jsonb_build_object(
         'total', count(*),
         'ready', count(*) filter (where status = 'ready'),
         'training', count(*) filter (where status = 'training'),
         'failed', count(*) filter (where status = 'failed'),
         'usersWithPersona', count(distinct user_id),
         -- No persona is trained any more (0032). The key stays, at zero, so
         -- the backoffice that reads it does not break; creations replace it.
         'trainingsInWindow', 0,
         'createdInWindow', count(*) filter (where created_at >= v_since)
       ) from personas)
      || jsonb_build_object(
         'refundedInWindow',
           (select count(distinct split_part(note, ':', 3)) from ledger_entries
             where note like 'refund:persona:%' and created_at >= v_since),
         'trainingCreditsInWindow',
           (select coalesce(-sum(amount_credits), 0) from ledger_entries
             where type = 'persona_training' and created_at >= v_since))
      || (select jsonb_build_object(
         'genCount', count(*),
         'genUsers', count(distinct user_id),
         'genCredits', coalesce(sum(price_credits) filter (where status <> 'failed'), 0)
       ) from generations
         where created_at >= v_since and settings->>'persona' is not null),
    'styles',
      (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'uses', uses, 'users', users)
                                 order by uses desc), '[]'::jsonb)
         from (select settings->>'style' as id, count(*) as uses, count(distinct user_id) as users
                 from generations
                where created_at >= v_since and settings->>'style' is not null
                group by 1) s),
    'trends',
      (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'uses', uses, 'users', users)
                                 order by uses desc), '[]'::jsonb)
         from (select settings->>'trend' as id, count(*) as uses, count(distinct user_id) as users
                 from generations
                where created_at >= v_since and settings->>'trend' is not null
                group by 1) t),
    'platforms',
      (select coalesce(jsonb_agg(jsonb_build_object('client', client, 'count', n)
                                 order by n desc), '[]'::jsonb)
         from (select client, count(*) as n from generations
                where created_at >= v_since group by client) p),
    'personaDaily',
      (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'count', n) order by d), '[]'::jsonb)
         from (select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as d, count(*) as n
                 from generations
                where created_at >= v_since and settings->>'persona' is not null
                group by 1) pd)
  ) into v_out;
  return v_out;
end $$;

-- ------------------------------------------------ 7. kill switch
-- Off. The gateway's modelGate has no owner bypass, so enable it first with
-- update public.models set enabled = true where id = 'persona'; then run the
-- live persona smoke, and if it fails set it back with this statement.
update public.models set enabled = false where id = 'persona';

-- ------------------------------------------------ 8. grants
revoke all on function public.fn_set_persona_photo(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fn_persona_photos_valid(jsonb) from public, anon, authenticated;
revoke all on function public.fn_persona_photos_complete(jsonb) from public, anon, authenticated;
grant execute on function public.fn_set_persona_photo(uuid, uuid, text, text) to service_role;
grant execute on function public.fn_persona_photos_valid(jsonb) to service_role;
grant execute on function public.fn_persona_photos_complete(jsonb) to service_role;
