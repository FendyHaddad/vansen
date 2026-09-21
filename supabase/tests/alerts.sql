-- Alerts: each condition raises its own incident, a repeat refreshes rather
-- than duplicates, and nothing resolves until a COMPLETE check proves it
-- clear. LOCAL DATABASE ONLY. See supabase/tests/upload_ownership.sql.
--
-- The property that matters most here is the last one. An alerting system that
-- closes incidents because it stopped running is worse than none: it reports
-- "all clear" precisely when it has lost the ability to know.
begin;

create or replace function pg_temp.open_kinds() returns text[] language sql as $$
  select coalesce(array_agg(kind order by kind), '{}') from public.alerts where resolved_at is null;
$$;

create or replace function pg_temp.video_job(p_user uuid, p_prompt text)
returns uuid language plpgsql as $$
declare v_gen uuid; v_job uuid;
begin
  insert into public.generations
    (user_id, kind, status, family_id, family_name, op, prompt, media_url, price_credits)
  values (p_user, 'video', 'pending', 'kling', 'Kling', 'generate', p_prompt, '', 100)
  returning id into v_gen;
  insert into public.jobs (user_id, generation_id, provider, state)
  values (p_user, v_gen, 'fal', 'ready') returning id into v_job;
  return v_job;
end $$;

-- 1. A clean database raises nothing.
do $$
begin
  perform public.fn_check_alerts();
  assert (select count(*) from public.alerts) = 0, 'a healthy system must be silent';
end $$;

-- 2. A generation marked done with no media is a critical incident.
do $$
declare v_user uuid := 'aaaa0000-0000-4000-8000-000000000001';
begin
  insert into auth.users (id, email) values (v_user, 'alerts1@example.com');
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict (id) do nothing;
  insert into public.generations
    (user_id, kind, status, family_id, family_name, op, prompt, media_url, price_credits, media_path)
  values (v_user, 'image', 'done', 'flux', 'FLUX', 'generate', 'a cat', '', 5, '');

  perform public.fn_check_alerts();

  assert 'done_without_media' = any(pg_temp.open_kinds()), 'a media-less completion must alert';
  assert (select severity from public.alerts where kind = 'done_without_media') = 'critical';
  assert (select (detail->>'count')::int from public.alerts where kind = 'done_without_media') = 1;
end $$;

-- 3. A repeat refreshes one incident rather than piling up rows.
do $$
declare v_first timestamptz; v_last timestamptz; v_rows int;
begin
  select first_seen_at into v_first from public.alerts where kind = 'done_without_media';
  perform pg_sleep(0.01);
  perform public.fn_check_alerts();

  select count(*) into v_rows from public.alerts where kind = 'done_without_media';
  assert v_rows = 1, format('expected one ongoing incident, got %s rows', v_rows);

  select first_seen_at, last_seen_at into v_first, v_last
    from public.alerts where kind = 'done_without_media';
  assert v_last > v_first, 'a repeat must move last_seen_at';
end $$;

-- 4. Two concurrent checks cannot open two incidents for one kind.
do $$
declare v_raised text := '';
begin
  begin
    insert into public.alerts (kind, severity, detail)
    values ('done_without_media', 'critical', '{}'::jsonb);
  exception when unique_violation then v_raised := 'blocked';
  end;
  assert v_raised = 'blocked', 'the open-incident index must reject a second open row';
end $$;

-- 5. A stuck job alerts as a warning, separately from a stuck training.
do $$
declare
  v_user uuid := 'aaaa0000-0000-4000-8000-000000000002';
  v_gen uuid;
begin
  insert into auth.users (id, email) values (v_user, 'alerts2@example.com');
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict (id) do nothing;
  insert into public.generations
    (user_id, kind, status, family_id, family_name, op, prompt, media_url, price_credits)
  values (v_user, 'image', 'pending', 'flux', 'FLUX', 'generate', 'a cat', '', 5)
  returning id into v_gen;
  insert into public.jobs (user_id, generation_id, provider, state, updated_at)
  values (v_user, v_gen, 'fal', 'submitting', now() - interval '20 minutes');

  perform public.fn_check_alerts();

  assert 'jobs_stuck' = any(pg_temp.open_kinds()), 'a job stuck mid-submit must alert';
  assert (select severity from public.alerts where kind = 'jobs_stuck') = 'warn';
  assert not ('trainings_stuck' = any(pg_temp.open_kinds())),
    'a stuck generation job must not be reported as a stuck training';
end $$;

-- 6. A deletion the outbox has given up on is critical: we told someone their
--    data was gone.
do $$
declare v_user uuid := 'aaaa0000-0000-4000-8000-000000000003'; v_obj uuid;
begin
  insert into auth.users (id, email) values (v_user, 'alerts3@example.com');
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict (id) do nothing;
  insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
  values (v_user, 'supabase', 'media', 'u/gone.png', 'media', 'delete_pending') returning id into v_obj;
  insert into public.deletion_outbox (object_id, backend, bucket, object_path, reason, attempts, not_before)
  values (v_obj, 'supabase', 'media', 'u/gone.png', 'user_delete', 7, now() - interval '1 minute');

  perform public.fn_check_alerts();

  assert 'deletion_stuck' = any(pg_temp.open_kinds()), 'an abandoned deletion must alert';
  assert (select severity from public.alerts where kind = 'deletion_stuck') = 'critical';
end $$;

-- 7. Provider burn is measured over the last hour, not all time. One expense
--    row per job (0020's unique index), so this needs two jobs.
do $$
declare
  v_user uuid := 'aaaa0000-0000-4000-8000-000000000004';
  v_old_job uuid; v_new_job uuid;
begin
  insert into auth.users (id, email) values (v_user, 'alerts4@example.com');
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict (id) do nothing;

  v_old_job := pg_temp.video_job(v_user, 'old spend');
  v_new_job := pg_temp.video_job(v_user, 'new spend');

  -- Old spend must not count, or the alert never clears after one bad hour.
  insert into public.provider_expenses (user_id, job_id, provider, reserved_usd, incurred_at)
  values (v_user, v_old_job, 'fal', 400, now() - interval '3 hours');
  perform public.fn_check_alerts();
  assert not ('provider_burn' = any(pg_temp.open_kinds())), 'spend from 3 hours ago is not a burn';

  insert into public.provider_expenses (user_id, job_id, provider, reserved_usd, incurred_at)
  values (v_user, v_new_job, 'fal', 75, now());
  perform public.fn_check_alerts();
  assert 'provider_burn' = any(pg_temp.open_kinds()), 'spend above the hourly ceiling must alert';
  assert (select (detail->>'usd_last_hour')::numeric from public.alerts
           where kind = 'provider_burn' and resolved_at is null) = 75,
    'the burn figure must cover the last hour only';
end $$;

-- 8. A condition that stops recurring resolves — but only because a COMPLETE
--    check ran and found it clear.
do $$
declare v_resolved timestamptz;
begin
  delete from public.deletion_outbox;
  perform public.fn_check_alerts();

  select resolved_at into v_resolved from public.alerts
   where kind = 'deletion_stuck' order by first_seen_at desc limit 1;
  assert v_resolved is not null, 'a cleared condition must resolve';
  assert 'done_without_media' = any(pg_temp.open_kinds()),
    'resolving one incident must not close the others';
end $$;

-- 9. Resolution requires evidence, not silence. Calling the resolver with the
--    still-firing set is what closes things; monitoring simply stopping must
--    leave every incident open.
do $$
declare v_open_before int; v_open_after int;
begin
  select count(*) into v_open_before from public.alerts where resolved_at is null;
  assert v_open_before > 0, 'this case needs an open incident to be meaningful';

  -- No check runs. Time passes. Nothing may close.
  perform pg_sleep(0.01);
  select count(*) into v_open_after from public.alerts where resolved_at is null;
  assert v_open_after = v_open_before,
    'an incident closed without a successful check is a false all-clear';
end $$;

-- 10. A reopened condition starts a NEW incident rather than reviving the old
--     one, so the resolved row remains an accurate history.
do $$
declare v_user uuid := 'aaaa0000-0000-4000-8000-000000000005'; v_rows int; v_obj uuid;
begin
  insert into auth.users (id, email) values (v_user, 'alerts5@example.com');
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict (id) do nothing;
  insert into public.storage_objects (user_id, backend, bucket, path, purpose, state)
  values (v_user, 'supabase', 'media', 'u/again.png', 'media', 'delete_pending') returning id into v_obj;
  insert into public.deletion_outbox (object_id, backend, bucket, object_path, reason, attempts, not_before)
  values (v_obj, 'supabase', 'media', 'u/again.png', 'user_delete', 9, now() - interval '1 minute');

  perform public.fn_check_alerts();

  select count(*) into v_rows from public.alerts where kind = 'deletion_stuck';
  assert v_rows = 2, format('expected a closed incident and a new open one, got %s', v_rows);
  assert (select count(*) from public.alerts
          where kind = 'deletion_stuck' and resolved_at is null) = 1;
end $$;

-- 11. The alert stream is not readable by a signed-in customer.
do $$
declare v_raised text := '';
begin
  set local role authenticated;
  begin
    perform 1 from public.alerts;
  exception when insufficient_privilege then v_raised := 'denied';
  end;
  reset role;
  assert v_raised = 'denied', 'alerts name other people''s failed payments';
end $$;

rollback;
