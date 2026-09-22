-- Crash recovery keeps progress separate from worker activity.
alter table public.jobs
  add column reconcile_attempts int not null default 0,
  add column progress_at timestamptz not null default now(),
  add column save_lease_token uuid;
alter table public.training_jobs add column progress_at timestamptz not null default now();
update public.jobs set progress_at = updated_at;
update public.training_jobs set progress_at = updated_at;

create or replace function public.fn_track_job_progress()
returns trigger language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    new.progress_at := least(new.progress_at, new.updated_at);
  elsif (new.state is distinct from old.state
         and not (old.state in ('submitting','reconciling') and new.state in ('submitting','reconciling')))
     or new.provider_ref is distinct from old.provider_ref then
    new.progress_at := now();
  end if;
  return new;
end $$;
create trigger job_progress before insert or update on public.jobs
  for each row execute function public.fn_track_job_progress();
create trigger training_progress before insert or update on public.training_jobs
  for each row execute function public.fn_track_job_progress();

create or replace function public.fn_count_reconciliation(p_job uuid, p_token uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_attempts int;
begin
  update public.jobs set reconcile_attempts = reconcile_attempts + 1
   where id=p_job and lease_token=p_token and lease_until>now() and state in ('submitting','reconciling')
   returning reconcile_attempts into v_attempts;
  return v_attempts;
end $$;

-- Saving is exclusive within a lease; its successor can reclaim abandoned work.
create or replace function public.fn_claim_job_save(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  update public.jobs set claimed_at=now(), save_lease_token=p_token, phase='saving'
   where id=p_job and state<>'done'
     and ((p_token is not null and lease_token=p_token and lease_until>now()
           and save_lease_token is distinct from p_token)
       or (p_token is null and lease_token is null and claimed_at is null))
   returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function public.fn_count_reconciliation(uuid,uuid), public.fn_claim_job_save(uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_count_reconciliation(uuid,uuid), public.fn_claim_job_save(uuid,uuid) to service_role;

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

  -- 4. Training that stalled the same way. Separate kind, because the fix and
  --    the refund path are different.
  select count(*) into v_n from public.training_jobs
   where state in ('submitting','reconciling')
     and progress_at < now() - interval '30 minutes';
  if v_n > 0 then
    perform public.fn_raise_alert('trainings_stuck', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('trainings_stuck'::text);
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

-- The scheduled checker may resolve only conditions it actually evaluated.
-- Runtime moderation incidents require an operator's successful probe to close.
create or replace function public.fn_resolve_checked_alerts(p_active jsonb)
returns int language plpgsql security definer set search_path=public as $$
declare v_n int;
begin
  update public.alerts set resolved_at=clock_timestamp()
   where resolved_at is null
     and kind in ('paid_unfulfilled','done_without_media','jobs_stuck','trainings_stuck',
                  'deletion_stuck','notifications_dead','provider_burn','moderation_surge')
     and kind not in (select jsonb_array_elements_text(coalesce(p_active,'[]'::jsonb)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
